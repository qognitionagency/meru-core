import { StateType } from '../entities/workflow-state.entity';
import { TransitionType } from '../entities/workflow-transition.entity';
import { WorkflowTrigger } from '../entities/workflow.entity';

export class CreateWorkflowDto {
  name: string;
  description?: string;
  entityType: string;
  trigger?: WorkflowTrigger;
  triggerConfig?: Record<string, any>;
  slaConfig?: {
    enabled: boolean;
    defaultSLA: number;
    escalationLevels: Array<{
      threshold: number;
      action: string;
      notify: string[];
    }>;
  };
  states: Array<{
    name: string;
    type: StateType;
    description?: string;
    config?: Record<string, any>;
  }>;
  transitions: Array<{
    name: string;
    from: string;
    to: string;
    type: TransitionType;
    conditions?: {
      operator: 'AND' | 'OR';
      rules: Array<{
        field: string;
        operator: string;
        value: any;
      }>;
    };
    actions?: Array<{
      type: string;
      config: Record<string, any>;
    }>;
    permissions?: {
      roles?: string[];
      users?: string[];
      requireApproval?: boolean;
      approvers?: string[];
    };
  }>;
}
