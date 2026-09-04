import type { AgentCard } from '@a2a-js/sdk';

export function profilerCard(port: number): AgentCard {
  return {
    name: 'Data Profiler Agent',
    description:
      'Analyzes a dataset column profile and returns a cleaning plan with justifications.',
    version: '1.0.0',
    supportedInterfaces: [
      { url: `http://localhost:${port}/`, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' },
    ],
    provider: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'analyze-data-quality',
        name: 'Data Quality Analysis',
        description:
          'Given a column profile, identify data quality issues and propose cleaning rules.',
        tags: ['data', 'quality', 'cleaning', 'profiling'],
        examples: [
          'Analyze this profile of a student records CSV and tell me how to clean it.',
        ],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}
