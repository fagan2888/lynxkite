// Create a random 'call graph' suitable as input for
// fingerprint_split_test.groovy.

seed = params.seed ?: '31415'
vertices = params.vertices ?: '30'
peripheralPct = params.peripheral ?: 50
peripheral = ((vertices.toInteger() * peripheralPct.toInteger()) / 100).toString()

ebSize = params.ebSize ?: '5'
mostCallsPossible = params.mostCalls ?: '3'
output = params.output ?: 'fprandom'

project = lynx.newProject()

project.newVertexSet(size: vertices)
project.createRandomEdgeBundle(degree: ebSize, seed: seed)
project.discardLoopEdges()
project.mergeParallelEdges()

// Attach a random weight (number of calls) to each edge.
project.addRandomEdgeAttribute(
  name: 'originalCallsUnif',
  dist: 'Standard Uniform',
  seed: seed
)
project.derivedEdgeAttribute(
  output: 'originalCalls',
  type: 'double',
  expr: 'Math.floor(originalCallsUnif * ' + mostCallsPossible + ');'
)

// Create a peripheral attribute.
project.vertexAttributeToDouble(
  attr: 'ordinal'
)

project.derivedVertexAttribute(
  output: 'peripheral',
  expr: 'ordinal < ' + peripheral.toString() + ' ? 1.0 : 0.0',
  type: 'double'
)

project.exportVertexAttributesToFile(
  path: 'DATA$/exports/' + output + '_vertices',
  link: 'vertices_csv',
  attrs: 'id,peripheral',
  format: 'CSV'
)

project.exportEdgeAttributesToFile(
  path: 'DATA$/exports/' + output + '_edges',
  link: 'edges_csv',
  attrs: 'originalCalls',
  id_attr: 'id',
  format: 'CSV'
)
