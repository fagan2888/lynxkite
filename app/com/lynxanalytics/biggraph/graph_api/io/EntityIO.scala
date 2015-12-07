// Classes for reading and writing EntityData to storage.

package com.lynxanalytics.biggraph.graph_api.io

import org.apache.spark
import org.apache.spark.HashPartitioner
import org.apache.spark.rdd.RDD
import play.api.libs.json

import com.lynxanalytics.biggraph.spark_util.Implicits._
import com.lynxanalytics.biggraph.spark_util.SortedRDD
import com.lynxanalytics.biggraph.{ bigGraphLogger => log }
import com.lynxanalytics.biggraph.graph_api._
import com.lynxanalytics.biggraph.graph_util.HadoopFile

case class IOContext(dataRoot: DataRoot, sparkContext: spark.SparkContext)

case class EntityMetadata(lines: Long, serialization: Option[String])

object EntityIO {
  // These "constants" are mutable for the sake of testing.
  var verticesPerPartition =
    scala.util.Properties.envOrElse(
      "KITE_VERTICES_PER_PARTITION",
      System.getProperty("biggraph.vertices.per.partition", "200000")).toInt
  var tolerance =
    System.getProperty("biggraph.vertices.partition.tolerance", "2.0").toDouble

  implicit val fEntityMetadata = json.Json.format[EntityMetadata]
  def operationPath(dataRoot: DataRoot, instance: MetaGraphOperationInstance) =
    dataRoot / io.OperationsDir / instance.gUID.toString
}

abstract class EntityIO(val entity: MetaGraphEntity, context: IOContext) {
  def correspondingVertexSet: Option[VertexSet] = None
  def read(parent: Option[VertexSetData] = None): EntityData
  def write(data: EntityData): Unit
  def delete(): Boolean
  def exists: Boolean
  def mayHaveExisted: Boolean // May be outdated or incorrectly true.

  protected val dataRoot = context.dataRoot
  protected val sc = context.sparkContext
  protected def operationMayHaveExisted = EntityIO.operationPath(dataRoot, entity.source).mayHaveExisted
  protected def operationExists = (EntityIO.operationPath(dataRoot, entity.source) / io.Success).exists
}

class ScalarIO[T](entity: Scalar[T], dMParam: IOContext)
    extends EntityIO(entity, dMParam) {

  def read(parent: Option[VertexSetData]): ScalarData[T] = {
    assert(parent == None, s"Scalar read called with parent $parent")
    log.info(s"PERF Loading scalar $entity from disk")
    val ois = new java.io.ObjectInputStream(serializedScalarFileName.forReading.open())
    val value = try ois.readObject.asInstanceOf[T] finally ois.close()
    log.info(s"PERF Loaded scalar $entity from disk")
    new ScalarData[T](entity, value)
  }

  def write(data: EntityData): Unit = {
    val scalarData = data.asInstanceOf[ScalarData[T]]
    log.info(s"PERF Writing scalar $entity to disk")
    val targetDir = path.forWriting
    targetDir.mkdirs
    val oos = new java.io.ObjectOutputStream(serializedScalarFileName.forWriting.create())
    try oos.writeObject(scalarData.value) finally oos.close()
    successPath.forWriting.createFromStrings("")
    log.info(s"PERF Written scalar $entity to disk")
  }
  def delete() = path.forWriting.deleteIfExists()
  def exists = operationExists && (path / Success).exists
  def mayHaveExisted = operationMayHaveExisted && path.mayHaveExisted

  private def path = dataRoot / ScalarsDir / entity.gUID.toString
  private def serializedScalarFileName: HadoopFileLike = path / "serialized_data"
  private def successPath: HadoopFileLike = path / Success
}

case class RatioSorter(elements: Seq[Int], desired: Int) {
  assert(desired > 0, "RatioSorter only supports positive integers")
  assert(elements.filter(_ <= 0).isEmpty, "RatioSorter only supports positive integers")
  private val sorted: Seq[(Int, Double)] = {
    elements.map { a =>
      val aa = a.toDouble
      if (aa > desired) (a, aa / desired)
      else (a, desired.toDouble / aa)
    }
      .sortBy(_._2)
  }

  val best: Option[Int] = sorted.map(_._1).headOption

  def getBestWithinTolerance(tolerance: Double): Option[Int] = {
    sorted.filter(_._2 < tolerance).map(_._1).headOption
  }

}

abstract class PartitionedDataIO[T, DT <: EntityRDDData[T]](entity: MetaGraphEntity,
                                                            dMParam: IOContext)
    extends EntityIO(entity, dMParam) {

  // This class reflects the current state of the disk during the read operation
  case class EntityLocationSnapshot(availablePartitions: Map[Int, HadoopFile]) {
    val hasPartitionedDirs = availablePartitions.nonEmpty
    val metaPathExists = metaFile.forReading.exists
    val hasPartitionedData = hasPartitionedDirs && metaPathExists

    val legacyPathExists = (legacyPath / io.Success).forReading.exists
    assert(hasPartitionedData || legacyPathExists,
      s"Legacy path $legacyPath does not exist, and there seems to be no valid data in $partitionedPath")

    private lazy val metadata: EntityMetadata = {
      import EntityIO.fEntityMetadata
      val j = json.Json.parse(metaFile.forReading.readAsString)
      j.as[EntityMetadata]
    }

    val numVertices =
      if (hasPartitionedData) metadata.lines
      else legacyRDD.count

    val serialization =
      if (hasPartitionedData) metadata.serialization.getOrElse("kryo")
      else "kryo"
  }

  def read(parent: Option[VertexSetData] = None): DT = {
    val entityLocation = EntityLocationSnapshot(computeAvailablePartitions)
    val pn = parent.map(_.rdd.partitions.size).getOrElse(selectPartitionNumber(entityLocation))
    val partitioner = parent.map(_.rdd.partitioner.get).getOrElse(new HashPartitioner(pn))

    val file =
      if (entityLocation.availablePartitions.contains(pn))
        entityLocation.availablePartitions(pn)
      else
        repartitionTo(entityLocation, partitioner)

    val dataRead = finalRead(
      file, entityLocation.numVertices, entityLocation.serialization, partitioner, parent)
    assert(dataRead.rdd.partitions.size == pn,
      s"finalRead mismatch: ${dataRead.rdd.partitions.size} != $pn")
    dataRead
  }

  def write(data: EntityData): Unit = {
    assert(data.entity == entity, s"Tried to write $data through EntityIO for $entity.")
    val rddData: EntityRDDData[T] = data.asInstanceOf[EntityRDDData[T]]
    log.info(s"PERF Instantiating entity $entity on disk")
    val rdd = rddData.rdd
    val partitions = rdd.partitions.size
    val (lines, serialization) = targetDir(partitions).saveEntityRDD(rdd)(rddData.typeTag)
    val metadata = EntityMetadata(lines, Some(serialization))
    writeMetadata(metadata)
    log.info(s"PERF Instantiated entity $entity on disk")
  }

  def delete(): Boolean = {
    legacyPath.forWriting.deleteIfExists() && partitionedPath.forWriting.deleteIfExists()
  }

  def exists = operationExists && (existsPartitioned || existsAtLegacy)

  def mayHaveExisted = operationMayHaveExisted && (partitionedPath.mayHaveExisted || legacyPath.mayHaveExisted)

  private val partitionedPath = dataRoot / PartitionedDir / entity.gUID.toString
  private val metaFile = partitionedPath / io.Metadata
  private val metaFileCreated = partitionedPath / io.MetadataCreate

  private def targetDir(numPartitions: Int) = {
    val subdir = numPartitions.toString
    partitionedPath.forWriting / subdir
  }

  private def writeMetadata(metaData: EntityMetadata) = {
    import EntityIO.fEntityMetadata
    assert(!metaFile.forWriting.exists, s"Metafile $metaFile should not exist before we write it.")
    metaFileCreated.forWriting.deleteIfExists()
    val j = json.Json.toJson(metaData)
    metaFileCreated.forWriting.createFromStrings(json.Json.prettyPrint(j))
    metaFileCreated.forWriting.renameTo(metaFile.forWriting)
  }

  private def computeAvailablePartitions = {
    val subDirs = (partitionedPath / "*").list
    val number = "[1-9][0-9]*".r
    val numericSubdirs = subDirs.filter(x => number.pattern.matcher(x.path.getName).matches)
    val existingCandidates = numericSubdirs.filter(x => (x / Success).exists)
    val resultList = existingCandidates.map { x => (x.path.getName.toInt, x) }
    resultList.toMap
  }

  // This method performs the actual reading of the rdddata, from a path
  // The parent VertexSetData is given for EdgeBundleData and AttributeData[T] so that
  // the corresponding data will be co-located.
  // A partitioner is also passed, because we don't want to create another one for VertexSetData
  protected def finalRead(path: HadoopFile,
                          count: Long,
                          serialization: String,
                          partitioner: org.apache.spark.Partitioner,
                          parent: Option[VertexSetData] = None): DT

  protected def legacyLoadRDD(path: HadoopFile): SortedRDD[Long, _]

  private def bestPartitionedSource(entityLocation: EntityLocationSnapshot, desiredPartitionNumber: Int) = {
    assert(entityLocation.availablePartitions.nonEmpty,
      s"there should be valid sub directories in $partitionedPath")
    val ratioSorter = RatioSorter(entityLocation.availablePartitions.map(_._1).toSeq, desiredPartitionNumber)
    entityLocation.availablePartitions(ratioSorter.best.get)
  }

  private def repartitionTo(entityLocation: EntityLocationSnapshot,
                            partitioner: org.apache.spark.Partitioner): HadoopFile = {
    if (entityLocation.hasPartitionedData)
      repartitionFromPartitionedRDD(entityLocation, partitioner)
    else
      repartitionFromLegacyRDD(entityLocation, partitioner)
  }

  private def repartitionFromPartitionedRDD(entityLocation: EntityLocationSnapshot,
                                            partitioner: org.apache.spark.Partitioner): HadoopFile = {
    val pn = partitioner.numPartitions
    val from = bestPartitionedSource(entityLocation, pn)
    val oldRDD = from.loadEntityRawRDD(sc)
    val newRDD = oldRDD.sort(partitioner)
    val newFile = targetDir(pn)
    val lines = newFile.saveEntityRawRDD(newRDD)
    assert(entityLocation.numVertices == lines, s"${entityLocation.numVertices} != $lines")
    newFile
  }

  private def repartitionFromLegacyRDD(entityLocation: EntityLocationSnapshot,
                                       partitioner: org.apache.spark.Partitioner): HadoopFile = {
    assert(entityLocation.legacyPathExists,
      s"There should be a valid legacy path at $legacyPath")
    val pn = partitioner.numPartitions
    val oldRDD = legacyRDD
    val newRDD = oldRDD.sort(partitioner)
    val newFile = targetDir(pn)
    val (lines, serialization) = newFile.saveEntityRDD(newRDD)
    assert(entityLocation.numVertices == lines, s"${entityLocation.numVertices} != $lines")
    writeMetadata(EntityMetadata(lines, Some(serialization)))
    newFile
  }

  private def legacyRDD = legacyLoadRDD(legacyPath.forReading)

  private def desiredPartitions(entityLocation: EntityLocationSnapshot) = {
    val vertices = entityLocation.numVertices
    val p = Math.ceil(vertices.toDouble / EntityIO.verticesPerPartition).toInt
    // Always have at least 1 partition.
    p max 1
  }

  private def selectPartitionNumber(entityLocation: EntityLocationSnapshot): Int = {
    val desired = desiredPartitions(entityLocation)
    val ratioSorter = RatioSorter(entityLocation.availablePartitions.map(_._1).toSeq, desired)
    ratioSorter.getBestWithinTolerance(EntityIO.tolerance).getOrElse(desired)
  }

  private def legacyPath = dataRoot / EntitiesDir / entity.gUID.toString
  private def existsAtLegacy = (legacyPath / Success).exists
  private def existsPartitioned = computeAvailablePartitions.nonEmpty && metaFile.exists

  protected def enforceCoLocationWithParent[T](rawRDD: RDD[(Long, T)],
                                               parent: VertexSetData): RDD[(Long, T)] = {
    val vsRDD = parent.rdd
    vsRDD.cacheBackingArray()
    // Enforcing colocation:
    assert(vsRDD.partitions.size == rawRDD.partitions.size,
      s"$vsRDD and $rawRDD should have the same number of partitions, " +
        s"but ${vsRDD.partitions.size} != ${rawRDD.partitions.size}")
    vsRDD.zipPartitions(rawRDD, preservesPartitioning = true) {
      (it1, it2) => it2
    }
  }
}

class VertexIO(entity: VertexSet, dMParam: IOContext)
    extends PartitionedDataIO[Unit, VertexSetData](entity, dMParam) {

  def legacyLoadRDD(path: HadoopFile): SortedRDD[Long, Unit] = {
    path.loadLegacyEntityRDD[Unit](sc)
  }

  def finalRead(path: HadoopFile,
                count: Long,
                serialization: String,
                partitioner: org.apache.spark.Partitioner,
                parent: Option[VertexSetData]): VertexSetData = {
    assert(parent == None, s"finalRead for $entity should not take a parent option")
    val rdd = path.loadEntityRDD[Unit](sc, serialization)
    new VertexSetData(entity, rdd.asUniqueSortedRDD(partitioner), Some(count))
  }
}

class EdgeBundleIO(entity: EdgeBundle, dMParam: IOContext)
    extends PartitionedDataIO[Edge, EdgeBundleData](entity, dMParam) {

  override def correspondingVertexSet = Some(entity.idSet)

  def legacyLoadRDD(path: HadoopFile): SortedRDD[Long, Edge] = {
    path.loadLegacyEntityRDD[Edge](sc)
  }

  def finalRead(path: HadoopFile,
                count: Long,
                serialization: String,
                partitioner: org.apache.spark.Partitioner,
                parent: Option[VertexSetData]): EdgeBundleData = {
    assert(partitioner eq parent.get.rdd.partitioner.get)
    val rdd = path.loadEntityRDD[Edge](sc, serialization)
    val coLocated = enforceCoLocationWithParent(rdd, parent.get)
    new EdgeBundleData(
      entity,
      coLocated.asUniqueSortedRDD(partitioner),
      Some(count))
  }
}

class AttributeIO[T](entity: Attribute[T], dMParam: IOContext)
    extends PartitionedDataIO[T, AttributeData[T]](entity, dMParam) {
  override def correspondingVertexSet = Some(entity.vertexSet)

  def legacyLoadRDD(path: HadoopFile): SortedRDD[Long, T] = {
    implicit val ct = entity.classTag
    path.loadLegacyEntityRDD[T](sc)
  }

  def finalRead(path: HadoopFile,
                count: Long,
                serialization: String,
                partitioner: org.apache.spark.Partitioner,
                parent: Option[VertexSetData]): AttributeData[T] = {
    assert(partitioner eq parent.get.rdd.partitioner.get)
    implicit val ct = entity.classTag
    implicit val tt = entity.typeTag
    val rdd = path.loadEntityRDD[T](sc, serialization)
    val coLocated = enforceCoLocationWithParent(rdd, parent.get)
    new AttributeData[T](
      entity,
      coLocated.asUniqueSortedRDD(partitioner),
      Some(count))
  }
}
