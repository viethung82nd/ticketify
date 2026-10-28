import globalSetup from '../../setup/global-setup';
import { scenariosEnabled } from './enabled';

/** The integration global setup (containers, template database), only when scenarios run. */
export default async function scenarioGlobalSetup(): Promise<void> {
  if (scenariosEnabled) await globalSetup();
}
