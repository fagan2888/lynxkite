package com.lynxanalytics.biggraph.graph_operations

import org.scalatest.FunSuite

import com.lynxanalytics.biggraph.graph_api._
import com.lynxanalytics.biggraph.graph_api.Scripting._
import com.lynxanalytics.biggraph.graph_api.GraphTestUtils._

class PartitionAttributeTest extends FunSuite with TestGraphOp {
  test("example graph - random role") {
    val g = ExampleGraph()().result
    val roleAttr = {
      val op = CreateRole(0.5, 0)
      op(op.vertices, g.vertices).result.role
    }
    val roles = roleAttr.rdd.collect.toMap
    assert(roles == Map(0 -> "train", 1 -> "test", 2 -> "train", 3 -> "train"))

    val op = PartitionAttribute[Double]()
    val out = op(op.attr, g.age)(op.role, roleAttr).result

    val test = out.test.rdd.collect
    val train = out.train.rdd.collect

    for ((id, age) <- test) assert(roles(id) == "test")
    for ((id, age) <- train) assert(roles(id) == "train")
    assert(test.size + train.size == roles.size)
  }
}
