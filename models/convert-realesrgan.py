"""Converts Real-ESRGAN's realesr-general-x4v3 (SRVGGNetCompact) to ONNX.

    python3 models/convert-realesrgan.py realesr-general-x4v3.pth models/realesr-general-x4v3.onnx

Weights: https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth
(BSD-3-Clause, Xintao Wang et al.). PyTorch is not needed: the checkpoint is
read with a minimal unpickler, and the graph is built with the onnx helpers.

Architecture (basicsr SRVGGNetCompact, num_feat=64, num_conv=32, upscale=4,
act=PReLU):
    body = conv3x3(3→64), PReLU, 32 × [conv3x3(64→64), PReLU], conv3x3(64→48)
    out  = pixel_shuffle(body(x), 4) + nearest_upsample(x, 4)
Input: 1×3×H×W RGB in [0,1]; output: 1×3×4H×4W (clamp to [0,1]).

`--check` also runs a NumPy reference forward pass on a random image and
compares it with the ONNX graph via onnx.reference.
"""
import pickle
import sys
import zipfile

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

SCALE = 4
NUM_CONV = 32


def load_state_dict(path):
    archive = zipfile.ZipFile(path)
    prefix = archive.namelist()[0].split('/')[0]

    class Unpickler(pickle.Unpickler):
        def find_class(self, module, name):
            if module == 'torch._utils' and name == '_rebuild_tensor_v2':
                def rebuild(storage, offset, size, stride, *_):
                    view = np.lib.stride_tricks.as_strided(storage[offset:], size, [s * 4 for s in stride])
                    return np.array(view, dtype=np.float32)
                return rebuild
            if module == 'torch' and name.endswith('Storage'):
                return name
            if module == 'collections' and name == 'OrderedDict':
                import collections
                return collections.OrderedDict
            raise pickle.UnpicklingError(f'unexpected {module}.{name}')

        def persistent_load(self, pid):
            _, storage_type, key, _location, _numel = pid
            assert storage_type == 'FloatStorage', storage_type
            return np.frombuffer(archive.read(f'{prefix}/data/{key}'), dtype=np.float32)

    state = Unpickler(archive.open(f'{prefix}/data.pkl')).load()
    return state.get('params', state.get('params_ema', state))


def build_graph(weights):
    nodes, inits = [], []

    def init(name, value):
        inits.append(numpy_helper.from_array(np.ascontiguousarray(value, dtype=np.float32), name))
        return name

    x = 'input'
    for i in range(NUM_CONV + 2):
        conv = 2 * i
        w = weights[f'body.{conv}.weight']
        b = weights[f'body.{conv}.bias']
        out = f'conv{i}'
        nodes.append(helper.make_node('Conv', [x, init(f'w{i}', w), init(f'b{i}', b)], [out], kernel_shape=[3, 3], pads=[1, 1, 1, 1]))
        x = out
        if i < NUM_CONV + 1:
            slope = weights[f'body.{conv + 1}.weight'].reshape(-1, 1, 1)
            out = f'prelu{i}'
            nodes.append(helper.make_node('PRelu', [x, init(f'a{i}', slope)], [out]))
            x = out
    nodes.append(helper.make_node('DepthToSpace', [x], ['shuffled'], blocksize=SCALE, mode='CRD'))
    scales = init('scales', np.array([1, 1, SCALE, SCALE], dtype=np.float32))
    nodes.append(helper.make_node('Resize', ['input', '', scales], ['base'], mode='nearest', coordinate_transformation_mode='asymmetric', nearest_mode='floor'))
    nodes.append(helper.make_node('Add', ['shuffled', 'base'], ['output']))

    graph = helper.make_graph(
        nodes,
        'realesr-general-x4v3',
        [helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, 3, 'height', 'width'])],
        [helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 3, 'out_height', 'out_width'])],
        inits,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)], producer_name='assetforge')
    model.ir_version = 8
    model.doc_string = 'Real-ESRGAN realesr-general-x4v3 (BSD-3-Clause, https://github.com/xinntao/Real-ESRGAN)'
    onnx.checker.check_model(model)
    return model


def reference_forward(weights, image):
    """NumPy SRVGGNetCompact forward (independent of the ONNX graph)."""
    def conv(x, w, b):
        c, h, wd = x.shape
        padded = np.pad(x, ((0, 0), (1, 1), (1, 1)))
        cols = np.stack([padded[:, dy:dy + h, dx:dx + wd] for dy in range(3) for dx in range(3)], axis=1)  # c,9,h,w
        out = np.tensordot(w.reshape(w.shape[0], c * 9), cols.reshape(c * 9, h * wd), axes=1).reshape(w.shape[0], h, wd)
        return out + b[:, None, None]

    x = image
    for i in range(NUM_CONV + 2):
        x = conv(x, weights[f'body.{2 * i}.weight'], weights[f'body.{2 * i}.bias'])
        if i < NUM_CONV + 1:
            a = weights[f'body.{2 * i + 1}.weight'][:, None, None]
            x = np.where(x >= 0, x, a * x)
    c, h, w = x.shape
    shuffled = x.reshape(3, SCALE, SCALE, h, w).transpose(0, 3, 1, 4, 2).reshape(3, h * SCALE, w * SCALE)
    base = image.repeat(SCALE, axis=1).repeat(SCALE, axis=2)
    return shuffled + base


def main():
    src, dst = sys.argv[1], sys.argv[2]
    weights = load_state_dict(src)
    model = build_graph(weights)
    onnx.save(model, dst)
    print(f'wrote {dst}')
    if '--check' in sys.argv:
        from onnx.reference import ReferenceEvaluator
        rng = np.random.default_rng(0)
        image = rng.random((3, 12, 10), dtype=np.float32)
        expected = reference_forward(weights, image)
        (actual,) = ReferenceEvaluator(model).run(None, {'input': image[None]})
        err = float(np.abs(actual[0] - expected).max())
        print(f'output {actual.shape}, max |onnx - numpy| = {err:.2e}')
        assert actual.shape == (1, 3, 48, 40) and err < 1e-4


if __name__ == '__main__':
    main()
