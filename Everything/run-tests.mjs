// Temporary runner: executes a suite under a hard wall-clock limit so a hung network probe or
// an unresolved promise can never block the terminal again.
//   node Everything/run-tests.mjs ui   |   node Everything/run-tests.mjs ask
const target = process.argv[2] === 'ask' ? 'ask-adapter.test.mjs' : 'ui-structure.test.mjs';

const timer = setTimeout(() => {
  console.log(`HARD TIMEOUT after 60s — ${target} never finished`);
  process.exit(9);
}, 60000);

import(`./tests/${target}`)
  .then(() => {
    clearTimeout(timer);
    console.log('SUITE FINISHED');
  })
  .catch((err) => {
    clearTimeout(timer);
    console.log('SUITE ERROR:', err && err.message);
    process.exit(1);
  });
