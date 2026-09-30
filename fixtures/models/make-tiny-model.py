"""
Generates fixtures/models/tiny-segmentation.onnx: a 3-node ONNX graph with
the same I/O contract as the real segmentation models
(input float32[1,3,H,W] -> output float32[1,1,H,W]).

mask = max(R,G,B) - min(R,G,B)   (per-pixel "colourfulness")

It lets the test-suite run the real ONNX Runtime code path (session creation,
tensor I/O, session reuse, output normalisation) without downloading a
multi-megabyte model. Regenerate with:  python3 fixtures/models/make-tiny-model.py
"""
import onnx
from onnx import TensorProto, helper

inp = helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, "height", "width"])
out = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 1, "height", "width"])
nodes = [
    helper.make_node("ReduceMax", ["input"], ["cmax"], axes=[1], keepdims=1),
    helper.make_node("ReduceMin", ["input"], ["cmin"], axes=[1], keepdims=1),
    helper.make_node("Sub", ["cmax", "cmin"], ["output"]),
]
graph = helper.make_graph(nodes, "tiny-segmentation", [inp], [out])
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="assetforge-tests")
model.ir_version = 8
onnx.checker.check_model(model)
onnx.save(model, __file__.replace("make-tiny-model.py", "tiny-segmentation.onnx"))
print("wrote tiny-segmentation.onnx")
