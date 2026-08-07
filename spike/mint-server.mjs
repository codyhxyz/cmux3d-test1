// Moved into the product tree. The minter now lives at src/server/cloud/, and
// `npm start` with CUBE_RUNTIME_ARN set serves the Cube and the minting API on one
// origin — which is the supported way to run the cloud path.
//
// This shim keeps the two-process flow in spike/README.md working unchanged.

export * from '../src/server/cloud/standalone.js';
import { main } from '../src/server/cloud/standalone.js';

await main(process.argv.slice(2));
