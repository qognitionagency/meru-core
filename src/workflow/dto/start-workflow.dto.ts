export class StartWorkflowDto {
  workflowId: string;
  entityId: string;
  entityType: string;
  context?: Record<string, any>;
}
