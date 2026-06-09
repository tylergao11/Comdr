import { startTUI } from '../packages/ui/dist/tui.js';
import { createMockEngine } from '../packages/ui/dist/mock-engine.js';

const engine = createMockEngine();
startTUI({ engine, mode: 'agent', initialInput: 'full pipeline test' });
