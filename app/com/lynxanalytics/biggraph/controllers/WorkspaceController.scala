// Methods for manipulating workspaces.
package com.lynxanalytics.biggraph.controllers

import scala.collection.mutable.HashMap
import com.lynxanalytics.biggraph.SparkFreeEnvironment
import com.lynxanalytics.biggraph.frontend_operations.Operations
import com.lynxanalytics.biggraph.graph_api._
import com.lynxanalytics.biggraph.serving

import scala.util.Random

case class GetWorkspaceRequest(name: String)
case class SetWorkspaceRequest(name: String, workspace: Workspace)
case class GetOutputIdRequest(workspace: String, output: BoxOutput)
case class GetOutputRequest(id: String)
case class GetOperationMetaRequest(workspace: String, box: String)
case class GetOutputIdResponse(id: String)
case class GetOutputResponse(kind: String, project: Option[FEProject] = None)
case class CreateWorkspaceRequest(name: String, privacy: String)
case class BoxCatalogResponse(boxes: List[BoxMetadata])

class WorkspaceController(env: SparkFreeEnvironment) {
  implicit val metaManager = env.metaGraphManager
  implicit val entityProgressManager: EntityProgressManager = env.entityProgressManager

  val ops = new Operations(env)

  private def assertNameNotExists(name: String) = {
    assert(!DirectoryEntry.fromName(name).exists, s"Entry '$name' already exists.")
  }

  def createWorkspace(
    user: serving.User, request: CreateWorkspaceRequest): Unit = metaManager.synchronized {
    assertNameNotExists(request.name)
    val entry = DirectoryEntry.fromName(request.name)
    entry.assertParentWriteAllowedFrom(user)
    val w = entry.asNewWorkspaceFrame()
    w.setupACL(request.privacy, user)
  }

  private def getWorkspaceByName(
    user: serving.User, name: String): Workspace = metaManager.synchronized {
    val f = DirectoryEntry.fromName(name)
    assert(f.exists, s"Project ${name} does not exist.")
    f.assertReadAllowedFrom(user)
    f match {
      case f: WorkspaceFrame => f.workspace
      case _ => throw new AssertionError(s"${name} is not a workspace.")
    }
  }

  def getWorkspace(
    user: serving.User, request: GetWorkspaceRequest): Workspace =
    getWorkspaceByName(user, request.name)

  val calculatedStates = new HashMap[String, (String, BoxOutputState)]()
  def getOutputId(
    user: serving.User, request: GetOutputIdRequest): GetOutputIdResponse = {
    val ws = getWorkspaceByName(user, request.workspace)
    val state = ws.state(user, ops, request.output)
    val id = Random.alphanumeric.take(20).mkString
    calculatedStates(id) = (request.workspace, state)
    GetOutputIdResponse(id)
  }

  def getOutput(
    user: serving.User, request: GetOutputRequest): GetOutputResponse = {
    calculatedStates.getOrElse(request.id, None) match {
      case Some((workspace:String, state: BoxOutputState)) =>
        state.kind match {
          case BoxOutputKind.Project =>
          GetOutputResponse (state.kind, project = Some (state.project.viewer.toFE(workspace)))
        }
    }
  }

  def setWorkspace(
    user: serving.User, request: SetWorkspaceRequest): Unit = metaManager.synchronized {
    val f = DirectoryEntry.fromName(request.name)
    assert(f.exists, s"Project ${request.name} does not exist.")
    f.assertWriteAllowedFrom(user)
    f match {
      case f: WorkspaceFrame =>
        val cp = request.workspace.checkpoint(previous = f.checkpoint)
        f.setCheckpoint(cp)
      case _ => throw new AssertionError(s"${request.name} is not a workspace.")
    }
  }

  def boxCatalog(user: serving.User, request: serving.Empty): BoxCatalogResponse = {
    BoxCatalogResponse(ops.operationIds.toList.map(ops.getBoxMetadata(_)))
  }

  def getOperationMeta(user: serving.User, request: GetOperationMetaRequest): FEOperationMeta = {
    val ws = getWorkspaceByName(user, request.workspace)
    val op = ws.getOperation(user, ops, request.box)
    op.toFE
  }
}
