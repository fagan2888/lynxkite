package com.lynxanalytics.biggraph.graph_operations

import org.scalatest.FunSuite

import com.lynxanalytics.biggraph.graph_api._
import com.lynxanalytics.biggraph.graph_api.GraphTestUtils._
import com.lynxanalytics.biggraph.graph_api.Scripting._

class PulledOverEdgesTest extends FunSuite with TestGraphOp {
  test("works with filters") {
    val g = ExampleGraph()().result
    implicit val d = SerializableType.double
    val fop = VertexAttributeFilter(GT(2.0))
    val fopRes = fop(fop.attr, g.weight).result

    val pop = PulledOverEdges()
    val pulledEB =
      pop(pop.injection, fopRes.identity)(pop.originalEB, g.edges).result.pulledEB

    assert(pulledEB.toPairSeq == Seq((2L, 0L), (2L, 1L)))
  }
}
