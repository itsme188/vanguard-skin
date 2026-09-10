/** Backward-compatible CLI: working diff by default, --base REF for the task diff. */
import { main } from "./verify-runner";
main(["changed", ...process.argv.slice(2)]).then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error); process.exitCode = 1;
});
