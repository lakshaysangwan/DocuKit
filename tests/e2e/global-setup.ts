import { generateFixtures } from './fixtures/generate';

/** Runs once before the whole suite — builds the real test files. */
export default async function globalSetup(): Promise<void> {
  await generateFixtures();
}
