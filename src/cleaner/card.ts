import type { AgentCard } from '@a2a-js/sdk';

export function cleanerCard(port: number): AgentCard {
  return {
    name: 'Data Cleaner Agent',
    description:
      'Cleans a CSV dataset, consulting a specialist Profiler agent over A2A for a cleaning plan.',
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
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'clean-dataset',
        name: 'Dataset Cleaning',
        description:
          'Given a path to a CSV file, clean it and produce a cleaned CSV plus a report. ' +
          'A delegated run over A2A has no human operator: any ambiguity question from the ' +
          'Profiler agent is answered with a documented default ("b"), disclosed in the report\'s ' +
          '"Human decision" section. The interactive CLI (`npm run clean`) asks a human instead.',
        tags: ['data', 'cleaning', 'csv'],
        examples: ['Clean data/students_raw.csv'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}
