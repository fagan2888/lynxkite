package com.lynxanalytics.biggraph.graph_operations

import com.lynxanalytics.biggraph.graph_api._

// Collects the attribute values into a scalar Map for a small ID set.
object CollectAttribute {
  class Output[T](
      implicit instance: MetaGraphOperationInstance,
      inputs: VertexAttributeInput[T]) extends MagicOutput(instance) {
    implicit val tt = inputs.attr.typeTag
    val attr = scalar[Map[ID, T]]
  }
}
import CollectAttribute._
case class CollectAttribute[T](
    idSet: Set[ID],
    maxCount: Int = 1000) extends TypedMetaGraphOp[VertexAttributeInput[T], Output[T]] {
  @transient override lazy val inputs = new VertexAttributeInput[T]
  def outputMeta(instance: MetaGraphOperationInstance) = new Output()(instance, inputs)

  def execute(inputDatas: DataSet, o: Output[T], output: OutputBuilder, rc: RuntimeContext) = {
    implicit val id = inputDatas
    val ids = idSet.take(maxCount).toIndexedSeq.sorted
    val restricted = inputs.attr.rdd.restrictToIdSet(ids)
    output(o.attr, restricted.collect.toMap)
  }
}
