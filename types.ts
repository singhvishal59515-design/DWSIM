export interface UserMessage {
  id: string;
  role: 'user';
  content: string;
  image?: {
    data: string; // base64 encoded
    mimeType: string;
  };
}

export interface AgentStep {
  thought: string;
  tool: 'Python' | 'DWSIM' | 'DataAnalysis' | 'FinalAnswer' | 'Visualization';
  tool_input?: string;
  tool_output?: string;
  is_final_answer: boolean;
}

export interface AgentResponse {
  plan: string[];
  steps: AgentStep[];
}

export interface AgentMessage {
  id: string;
  role: 'agent';
  content: AgentResponse;
}

export type ChatMessage = UserMessage | AgentMessage;