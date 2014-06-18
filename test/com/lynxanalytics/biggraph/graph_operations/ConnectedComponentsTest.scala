package com.lynxanalytics.biggraph.graph_operations

import org.apache.spark
import org.apache.spark.SparkContext.rddToPairRDDFunctions
import org.scalatest.FunSuite

import com.lynxanalytics.biggraph.TestSparkContext
import com.lynxanalytics.biggraph.TestUtils
import com.lynxanalytics.biggraph.graph_api._
import com.lynxanalytics.biggraph.graph_api.attributes._

object ConnectedComponentsTest {
  def assertSameComponents(comp1: Map[Long, Long], icomp2: Map[Int, Int]): Unit = {
    val comp2 = icomp2.map { case (a, b) => (a.toLong, b.toLong) }
    val mapping = scala.collection.mutable.Map[Long, Long]()
    assert(comp1.size == comp2.size, "Unexpected size")
    for (k <- comp1.keys) {
      assert(comp2.contains(k), s"Missing key: $k")
      val c1 = comp1(k)
      val c2 = comp2(k)
      if (mapping.contains(c1)) {
        assert(mapping(c1) == c2, s"Unable to match components $c1 and $c2")
      } else {
        mapping(c1) = c2
      }
    }
  }
}
class ConnectedComponentsTest extends FunSuite with TestGraphOperation {
  import ConnectedComponentsTest._

  // Creates the graph specified by `nodes` and applies ConnectedComponents to it.
  // Returns the resulting component attributes in an easy-to-use format.
  def getComponents(nodes: Map[Int, Seq[Int]], local: Boolean): Map[Long, Long] = {
    ConnectedComponents.maxEdgesProcessedLocally = if (local) 100000 else 0
    val sg = helper.apply(SmallTestGraph(nodes))
    val cc = helper.apply(ConnectedComponents(), sg.mapNames('vs -> 'vs, 'es -> 'es))

    helper.localData(cc.edgeBundles('links)).toMap
  }

  test("three islands") {
    val nodes = Map(0 -> Seq(), 1 -> Seq(), 2 -> Seq())

    val expectation = Map(0 -> 0, 1 -> 1, 2 -> 2)
    assertSameComponents(getComponents(nodes, local = true), expectation)
    assertSameComponents(getComponents(nodes, local = false), expectation)
  }

  test("triangle") {
    val nodes = Map(0 -> Seq(1, 2), 1 -> Seq(0, 2), 2 -> Seq(0, 1))
    val expectation = Map(0 -> 0, 1 -> 0, 2 -> 0)
    assertSameComponents(getComponents(nodes, local = true), expectation)
    assertSameComponents(getComponents(nodes, local = false), expectation)
  }

  test("island and line") {
    val nodes = Map(0 -> Seq(), 1 -> Seq(2), 2 -> Seq(1))
    val expectation = Map(0 -> 0, 1 -> 1, 2 -> 1)
    assertSameComponents(getComponents(nodes, local = true), expectation)
    assertSameComponents(getComponents(nodes, local = false), expectation)
  }

  test("long line") {
    val nodes = Map(0 -> Seq(1), 1 -> Seq(0, 2), 2 -> Seq(1, 3), 3 -> Seq(2))
    val expectation = Map(0 -> 0, 1 -> 0, 2 -> 0, 3 -> 0)
    assertSameComponents(getComponents(nodes, local = true), expectation)
    assertSameComponents(getComponents(nodes, local = false), expectation)
  }
}
