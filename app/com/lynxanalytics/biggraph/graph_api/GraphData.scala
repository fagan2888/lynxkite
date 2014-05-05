package com.lynxanalytics.biggraph.graph_api

import org.apache.spark
import org.apache.spark.graphx
import org.apache.spark.rdd

import attributes.DenseAttributes

/**
 * Generic representation of a graph as RDDs.
 *
 * Different implementations might have different performance tradeoffs.
 * Use GraphDataManager to get the data for a BigGraph.
 */
trait GraphData {
  type VertexRDD = rdd.RDD[(graphx.VertexId, DenseAttributes)]
  type EdgeRDD = rdd.RDD[graphx.Edge[DenseAttributes]]
  type TripletRDD = rdd.RDD[graphx.EdgeTriplet[DenseAttributes, DenseAttributes]]

  val bigGraph: BigGraph

  def vertices: VertexRDD
  def edges: EdgeRDD
  def triplets: TripletRDD
}

/*
 * Interface for obtaining GraphData for a given BigGraph.
 */
abstract class GraphDataManager {
  def obtainData(bigGraph: BigGraph): GraphData

  // Makes this graph manager to save the given BigGraph
  // to disk. This triggers a computation if necessary.
  def saveDataToDisk(bigGraph: BigGraph)

  // Returns information about the current running enviroment.
  // Typically used by operations to optimize their execution.
  def runtimeContext: RuntimeContext
}
object GraphDataManager {
  def apply(repositoryPath: String): GraphDataManager = new GraphDataManagerImpl(repositoryPath)
}

class RuntimeContext(val sparkContext: spark.SparkContext) {
  // The number of cores available for computaitons.
  def numAvailableCores() = ???

  // Total memory  available for RDD operations.
  def availableTransientMemoryGB() = ???

  // Total memory available for caching RDDs.
  def availableCacheMemoryGB() = ???
}
