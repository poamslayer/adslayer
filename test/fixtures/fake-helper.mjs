// Speaks the helper's JSON-lines protocol, for tests on any OS (ADR-0002). The op picks a behaviour.
import { createInterface } from "node:readline";

process.stderr.write("fake-helper: ready\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  const { id, op, args } = JSON.parse(line);
  const answer = (body) => process.stdout.write(JSON.stringify({ id, ...body }) + "\n");
  switch (op) {
    case "echo":
      return answer({ ok: true, value: { args, pid: process.pid } });
    case "slow":
      await new Promise((r) => setTimeout(r, args.ms));
      return answer({ ok: true, value: args.ms });
    case "fail":
      return answer({ ok: false, error: { code: "InsufficientAccessRights", message: "no" } });
    case "garbage":
      process.stdout.write("this is not json\n");
      return answer({ ok: true, value: "after garbage" });
    case "crash":
      process.stderr.write("fake-helper: about to crash\n");
      process.exit(3);
    case "hang":
      return;
    default:
      return answer({ ok: false, error: { code: "BadRequest", message: `unknown op '${op}'` } });
  }
});
