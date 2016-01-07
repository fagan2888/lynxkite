// Core classes for representing columnar data using meta graph entities.

package com.lynxanalytics.biggraph.controllers

import com.lynxanalytics.biggraph.graph_api._
import com.lynxanalytics.biggraph.graph_operations

import org.apache.spark

trait Table {
  def idSet: VertexSet
  def columns: Map[String, Attribute[_]]

  def asDataFrame(implicit dataManager: DataManager): spark.sql.DataFrame = ???
  def dataFrameSchema(implicit dataManager: DataManager): spark.sql.types.StructType = ???
}
object Table {
  // A canonical table path is what's used by operations to reference a table. It's always meant to
  // be a valid id for an FEOption.
  // A canonical table path can be in one of the follow formats:
  // 1. sub-project relative reference:
  //    RELATIVE_REFERENCE := (SEGMENTATION_NAME|)*TABLE_NAME
  //    e.g.: connected components|!vertices
  // 2. project frame relative reference:
  //    ABSOLUTE_REFERENCE := |RELATIVE_REFERENCE
  //    e.g.: |events|connected components|!edges
  // 3. global reference:
  //    !checkpoint(CHECKPOINT,CHECKPOINT_NOTE)ABSOLUTE_REFERENCE
  //    e.g.: !checkpoint(1234,"My Favorite Project")|!vertices
  //
  // TABLE_NAME either points to a user defined table within the root project/segmentation
  // or can be one of the following implicitly defined tables:
  //  !vertices
  //  !edges
  //  !belongsTo - only defined for segmentations
  //
  // The last two formats are only meaningful in the context of a project viewer. Global paths
  // can be resolved out of context as well, so there is a specialized function just for those.
  def fromGlobalPath(globalPath: String)(implicit metaManager: MetaGraphManager): Table = {
    val (checkpoint, _, suffix) = FEOption.unpackTitledCheckpoint(
      globalPath,
      s"$globalPath does not seem to be a valid global table path")
    fromCheckpointAndPath(checkpoint, suffix)
  }
  def fromCanonicalPath(path: String, context: ProjectViewer)(
    implicit metaManager: MetaGraphManager): Table = {

    FEOption.maybeUnpackTitledCheckpoint(path)
      .map { case (checkpoint, _, suffix) => fromCheckpointAndPath(checkpoint, suffix) }
      .getOrElse(fromPath(path, context))
  }
  val VERTEX_TABLE_NAME = "!vertices"
  val EDGE_TABLE_NAME = "!edges"
  val BELONGS_TO_TABLE_NAME = "!belongsTo"
  def fromTableName(tableName: String, viewer: ProjectViewer): Table = {
    tableName match {
      case VERTEX_TABLE_NAME => new VertexTable(viewer)
      case EDGE_TABLE_NAME => new EdgeTable(viewer)
      case BELONGS_TO_TABLE_NAME => {
        assert(
          viewer.isInstanceOf[SegmentationViewer],
          "The !belongsTo table is only defined on segmentations")
        new BelongsToTable(viewer.asInstanceOf[SegmentationViewer])
      }
      case customTableName: String => {
        println(customTableName)
        ???
      }
    }
  }
  def fromRelativePath(relativePath: String, viewer: ProjectViewer): Table = {
    val splitPath = SubProject.splitPipedPath(relativePath)
    fromTableName(splitPath.last, viewer.offspringViewer(splitPath.dropRight(1)))
  }
  def fromPath(path: String, viewer: ProjectViewer): Table = {
    if (path(0) == '|') {
      fromRelativePath(path.drop(1), viewer.rootViewer)
    } else {
      fromRelativePath(path, viewer)
    }
  }
  def fromCheckpointAndPath(checkpoint: String, path: String)(
    implicit manager: MetaGraphManager): Table = {
    val rootViewer = new RootProjectViewer(manager.checkpointRepo.readCheckpoint(checkpoint))
    fromPath(path, rootViewer)
  }
}

class VertexTable(project: ProjectViewer) extends Table {
  assert(project.vertexSet != null, "Cannot define a VertexTable on a project w/o vertices")

  def idSet = project.vertexSet
  def columns = project.vertexAttributes
}

class EdgeTable(project: ProjectViewer) extends Table {
  assert(project.edgeBundle != null, "Cannot define an EdgeTable on a project w/o vertices")

  def idSet = project.edgeBundle.idSet
  def columns = {
    implicit val metaManager = project.vertexSet.source.manager
    val fromVertexAttributes = project.vertexAttributes.flatMap {
      case (name, attr) =>
        Iterator[(String, Attribute[_])](
          "src$" + name ->
            graph_operations.VertexToEdgeAttribute.srcAttribute(attr, project.edgeBundle),
          "dst$" + name ->
            graph_operations.VertexToEdgeAttribute.srcAttribute(attr, project.edgeBundle))
    }
    project.edgeAttributes ++ fromVertexAttributes
  }
}

class BelongsToTable(segmentation: SegmentationViewer) extends Table {
  def idSet = segmentation.belongsTo.idSet
  def columns = {
    implicit val metaManager = segmentation.vertexSet.source.manager
    val baseProjectAttributes = segmentation.parent.vertexAttributes.map {
      case (name, attr) =>
        ("base$" + name ->
          graph_operations.VertexToEdgeAttribute.srcAttribute(
            attr, segmentation.belongsTo)): (String, Attribute[_])
    }
    val segmentationAttributes = segmentation.vertexAttributes.map {
      case (name, attr) =>
        ("segment$" + name ->
          graph_operations.VertexToEdgeAttribute.dstAttribute(
            attr, segmentation.belongsTo)): (String, Attribute[_])
    }
    baseProjectAttributes ++ segmentationAttributes
  }
}
