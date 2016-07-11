// Trains a logistic regression model. 
// Currently, this class only supports binary classification.
package com.lynxanalytics.biggraph.graph_operations

import com.lynxanalytics.biggraph.graph_api._
import com.lynxanalytics.biggraph.model._
import org.apache.spark.ml.classification.LogisticRegression
import org.apache.spark.mllib.feature.StandardScalerModel
import org.apache.spark.mllib.linalg.Vectors

object LogisticRegressionModelTrainer extends OpFromJson {
  class Input(numFeatures: Int) extends MagicInputSignature {
    val vertices = vertexSet
    val features = (0 until numFeatures).map {
      i => vertexAttribute[Double](vertices, Symbol(s"feature-$i"))
    }
    val label = vertexAttribute[Double](vertices)
  }
  class Output(implicit instance: MetaGraphOperationInstance,
               inputs: Input) extends MagicOutput(instance) {
    val model = scalar[Model]
  }
  def fromJson(j: JsValue) = LogisticRegressionModelTrainer(
    (j \ "threshold").as[Double],
    (j \ "maxIter").as[Int],
    (j \ "labelName").as[String],
    (j \ "featureNames").as[List[String]])
}
import LogisticRegressionModelTrainer._
case class LogisticRegressionModelTrainer(
    threshold: Double,
    maxIter: Int,
    labelName: String,
    featureNames: List[String]) extends TypedMetaGraphOp[Input, Output] with ModelMeta {
  val isClassification = true
  override val nominalOutput = true
  override val isHeavy = true
  @transient override lazy val inputs = new Input(featureNames.size)
  def outputMeta(instance: MetaGraphOperationInstance) = new Output()(instance, inputs)
  override def toJson = Json.obj(
    "threshold" -> threshold,
    "maxIter" -> maxIter,
    "labelName" -> labelName,
    "featureNames" -> featureNames)

  def execute(inputDatas: DataSet,
              o: Output,
              output: OutputBuilder,
              rc: RuntimeContext): Unit = {
    implicit val id = inputDatas
    val sqlContext = rc.dataManager.newSQLContext()
    import sqlContext.implicits._

    val rddArray = inputs.features.toArray.map { v => v.rdd }
    val featuresRDD = Model.toLinalgVector(rddArray, inputs.vertices.rdd)
    val scaledDF = featuresRDD.sortedJoin(inputs.label.rdd).values.toDF("vector", "label")

    // Train a logictic regression model from the scaled vectors
    val logit = new LogisticRegression()
      .setThreshold(threshold)
      .setMaxIter(maxIter)
      .setFeaturesCol("vector")
      .setLabelCol("label")
      .setPredictionCol("prediction")
      .setProbabilityCol("probability")

    val model = logit.fit(scaledDF)
    val file = Model.newModelFile
    model.save(file.resolvedName)
    output(o.model, Model(
      method = "Logistic regression",
      symbolicPath = file.symbolicName,
      labelName = Some(labelName),
      featureNames = featureNames,
      labelScaler = None,
      // The feature vectors have been standardized
      featureScaler = {
        val dummyVector = Vectors.dense(Array.fill(featureNames.size)(0.0))
        new StandardScalerModel(
          std = dummyVector, mean = dummyVector, withStd = false, withMean = false)
      }))
  }
}
