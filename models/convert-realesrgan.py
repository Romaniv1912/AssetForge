"""Converts Real-ESRGAN ×4 checkpoints to ONNX (no PyTorch needed).

    python3 models/convert-realesrgan.py <weights.pth> <out.onnx> [--check]

Supported (BSD-3-Clause, Xintao Wang et al., https://github.com/xinntao/Real-ESRGAN/releases):
  realesr-general-x4v3.pth         SRVGGNetCompact (v0.2.5.0)
  RealESRGAN_x4plus_anime_6B.pth   RRDBNet, 6 blocks (v0.2.2.4)
  RealESRGAN_x4plus.pth            RRDBNet, 23 blocks (v0.1.0)
The architecture is detected from the checkpoint keys. The checkpoint is read
with a minimal unpickler and the graph is built with the onnx helpers.

SRVGGNetCompact (num_feat=64, num_conv=32, act=PReLU):
    body = conv3x3(3→64), PReLU, 32 × [conv3x3(64→64), PReLU], conv3x3(64→48)
    out  = pixel_shuffle(body(x), 4) + nearest_upsample(x, 4)
RRDBNet (num_feat=64, num_grow_ch=32, LeakyReLU 0.2, basicsr):
    feat = conv_first(x); feat += conv_body(RRDB × N (feat))
    2 × [nearest ×2, conv, lrelu]; conv_hr, lrelu; conv_last
    RRDB = 3 × ResidualDenseBlock (5 dense convs, residual ×0.2), residual ×0.2
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
    # EMA weights are the released (better) ones when both are present.
    return state.get('params_ema', state.get('params', state))


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


def rrdb_blocks(weights):
    return 1 + max(int(k.split('.')[1]) for k in weights if k.startswith('body.'))


def build_rrdb_graph(weights, name):
    nodes, inits = [], []
    counter = [0]

    def fresh(prefix):
        counter[0] += 1
        return f'{prefix}{counter[0]}'

    def const(value):
        n = fresh('c')
        inits.append(numpy_helper.from_array(np.ascontiguousarray(value, dtype=np.float32), n))
        return n

    def conv(x, key):
        out = fresh('conv')
        nodes.append(helper.make_node('Conv', [x, const(weights[f'{key}.weight']), const(weights[f'{key}.bias'])], [out], kernel_shape=[3, 3], pads=[1, 1, 1, 1]))
        return out

    def lrelu(x):
        out = fresh('lrelu')
        nodes.append(helper.make_node('LeakyRelu', [x], [out], alpha=0.2))
        return out

    def concat(xs):
        out = fresh('cat')
        nodes.append(helper.make_node('Concat', xs, [out], axis=1))
        return out

    def scaled_residual(x, residual):
        scaled = fresh('mul')
        nodes.append(helper.make_node('Mul', [x, const(np.array(0.2, dtype=np.float32))], [scaled]))
        out = fresh('add')
        nodes.append(helper.make_node('Add', [scaled, residual], [out]))
        return out

    def rdb(x, key):
        feats = [x]
        for i in range(1, 5):
            feats.append(lrelu(conv(concat(feats) if len(feats) > 1 else x, f'{key}.conv{i}')))
        return scaled_residual(conv(concat(feats), f'{key}.conv5'), x)

    def upsample(x):
        out = fresh('up')
        nodes.append(helper.make_node('Resize', [x, '', const(np.array([1, 1, 2, 2], dtype=np.float32))], [out], mode='nearest', coordinate_transformation_mode='asymmetric', nearest_mode='floor'))
        return out

    feat = conv('input', 'conv_first')
    body = feat
    for b in range(rrdb_blocks(weights)):
        block_in = body
        for r in (1, 2, 3):
            body = rdb(body, f'body.{b}.rdb{r}')
        body = scaled_residual(body, block_in)
    body = conv(body, 'conv_body')
    feat_sum = fresh('add')
    nodes.append(helper.make_node('Add', [feat, body], [feat_sum]))
    x = lrelu(conv(upsample(feat_sum), 'conv_up1'))
    x = lrelu(conv(upsample(x), 'conv_up2'))
    x = lrelu(conv(x, 'conv_hr'))
    last = conv(x, 'conv_last')
    nodes.append(helper.make_node('Identity', [last], ['output']))
    graph = helper.make_graph(
        nodes,
        name,
        [helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, 3, 'height', 'width'])],
        [helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 3, 'out_height', 'out_width'])],
        inits,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)], producer_name='assetforge')
    model.ir_version = 8
    model.doc_string = f'Real-ESRGAN {name} (BSD-3-Clause, https://github.com/xinntao/Real-ESRGAN)'
    onnx.checker.check_model(model)
    return model


def np_conv(x, w, b):
    c, h, wd = x.shape
    padded = np.pad(x, ((0, 0), (1, 1), (1, 1)))
    cols = np.stack([padded[:, dy:dy + h, dx:dx + wd] for dy in range(3) for dx in range(3)], axis=1)
    return np.tensordot(w.reshape(w.shape[0], c * 9), cols.reshape(c * 9, h * wd), axes=1).reshape(w.shape[0], h, wd) + b[:, None, None]


def rrdb_reference(weights, image):
    lrelu = lambda v: np.where(v >= 0, v, 0.2 * v)
    c = lambda x, k: np_conv(x, weights[f'{k}.weight'], weights[f'{k}.bias'])
    up = lambda v: v.repeat(2, axis=1).repeat(2, axis=2)
    feat = c(image, 'conv_first')
    body = feat
    for b in range(rrdb_blocks(weights)):
        block_in = body
        for r in (1, 2, 3):
            key = f'body.{b}.rdb{r}'
            x = body
            feats = [x]
            for i in range(1, 5):
                feats.append(lrelu(c(np.concatenate(feats), f'{key}.conv{i}')))
            body = c(np.concatenate(feats), f'{key}.conv5') * 0.2 + x
        body = body * 0.2 + block_in
    feat = feat + c(body, 'conv_body')
    x = lrelu(c(up(feat), 'conv_up1'))
    x = lrelu(c(up(x), 'conv_up2'))
    return c(lrelu(c(x, 'conv_hr')), 'conv_last')


def main():
    src, dst = sys.argv[1], sys.argv[2]
    weights = load_state_dict(src)
    rrdb = 'conv_first.weight' in weights
    name = dst.rsplit('/', 1)[-1].removesuffix('.onnx')
    model = build_rrdb_graph(weights, name) if rrdb else build_graph(weights)
    onnx.save(model, dst)
    print(f'wrote {dst} ({"RRDBNet, %d blocks" % rrdb_blocks(weights) if rrdb else "SRVGGNetCompact"})')
    if '--check' in sys.argv:
        from onnx.reference import ReferenceEvaluator
        rng = np.random.default_rng(0)
        image = rng.random((3, 12, 10), dtype=np.float32)
        expected = rrdb_reference(weights, image) if rrdb else reference_forward(weights, image)
        (actual,) = ReferenceEvaluator(model).run(None, {'input': image[None]})
        err = float(np.abs(actual[0] - expected).max())
        print(f'output {actual.shape}, max |onnx - numpy| = {err:.2e}')
        assert actual.shape == (1, 3, 48, 40) and err < 1e-4


if __name__ == '__main__':
    main()
