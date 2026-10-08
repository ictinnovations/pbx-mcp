/**
 * A tiny in-process AMI server for tests: no network beyond loopback.
 *
 * It models just enough of Asterisk for provisioning: Login, GetConfig,
 * UpdateConfig (newcat / append / delcat, with Asterisk's refusal of duplicate
 * category names and all-or-nothing batches), and the two CLI commands the
 * provisioner issues.
 */

import net from "node:net";

export async function startMockAmi(seed = {}) {
  // seed: { name: vars } for unique names, or [{ name, vars }] to repeat a name.
  const state = {
    received: [], // every parsed request, in order
    categories: (Array.isArray(seed) ? seed : Object.entries(seed).map(([name, vars]) => ({ name, vars }))), // names may repeat, like the real file
    failVerify: false, // make `pjsip show endpoint` claim nothing exists
    swallowNext: undefined, // an Action name: apply it, but never reply (once)
    dropNext: undefined, // an Action name: neither apply nor reply (once)
    delayMs: 0, // delay every reply, to expose interleaving
    sockets: new Set(),
  };

  const server = net.createServer((sock) => {
    state.sockets.add(sock);
    sock.on("close", () => state.sockets.delete(sock));
    sock.on("error", () => {});
    sock.setEncoding("utf8");
    sock.write("Asterisk Call Manager/9.0.0\r\n");
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\r\n\r\n")) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 4);
        const req = {};
        for (const line of raw.split("\r\n")) {
          const c = line.indexOf(":");
          if (c > 0) req[line.slice(0, c).trim()] = line.slice(c + 1).trim();
        }
        state.received.push(req);
        if (state.dropNext === req.Action) {
          state.dropNext = undefined;
          continue;
        }
        const reply = respond(req);
        if (state.swallowNext === req.Action) {
          state.swallowNext = undefined;
          continue;
        }
        setTimeout(() => sock.write(`${reply}\r\nActionID: ${req.ActionID}\r\n\r\n`), state.delayMs);
      }
    });
  });

  const out = (lines) => lines.join("\r\n");
  const cli = (text) =>
    out(["Response: Success", "Message: Command output follows", ...text.split("\n").map((l) => `Output: ${l}`)]);
  const err = (m) => out(["Response: Error", `Message: ${m}`]);

  function respond(req) {
    switch (req.Action) {
      case "Login":
        return out(["Response: Success", "Message: Authentication accepted"]);
      case "GetConfig": {
        const lines = ["Response: Success"];
        let n = 0;
        for (const { name, vars } of state.categories) {
          const c = String(n++).padStart(6, "0");
          lines.push(`Category-${c}: ${name}`);
          vars.forEach(([k, v], j) => lines.push(`Line-${c}-${String(j).padStart(6, "0")}: ${k}=${v}`));
        }
        return out(lines);
      }
      case "UpdateConfig": {
        const next = state.categories.map((c) => ({ name: c.name, vars: [...c.vars] }));
        const vtype = (c) => c.vars.find(([k]) => k === "type")?.[1];
        for (let i = 0; `Action-${String(i).padStart(6, "0")}` in req; i++) {
          const n = String(i).padStart(6, "0");
          const cat = req[`Cat-${n}`];
          const action = req[`Action-${n}`];
          const opts = req[`Options-${n}`] ?? "";
          const filter = /catfilter="type=\^(\w+)\$"/.exec(opts)?.[1];
          const matches = (c) => c.name === cat && (!filter || vtype(c) === filter);
          if (action === "newcat") {
            // Asterisk refuses a duplicate name unless Options has allowdups.
            if (next.some((c) => c.name === cat) && !opts.includes("allowdups")) return err("Create category did not complete successfully");
            next.push({ name: cat, vars: [] });
          } else if (action === "append") {
            const hit = next.filter(matches);
            if (!hit.length) return err("Update category did not complete successfully");
            hit.forEach((c) => c.vars.push([req[`Var-${n}`], req[`Value-${n}`]])); // appends hit EVERY same-named category
          } else if (action === "renamecat") {
            const hit = next.find(matches);
            if (!hit) return err("Rename category did not complete successfully");
            hit.name = req[`Value-${n}`]; // rename does not check for duplicates
          } else if (action === "delcat") {
            const before = next.length;
            for (let j = next.length - 1; j >= 0; j--) if (matches(next[j])) next.splice(j, 1);
            if (next.length === before) return err("Delete category did not complete successfully");
          } else return err("Unknown action");
        }
        state.categories = next;
        return "Response: Success";
      }
      case "Command": {
        const c = req.Command;
        if (c === "module reload res_pjsip.so") return cli("Module 'res_pjsip.so' reloaded successfully.");
        const m = /^pjsip show endpoint (\S+)$/.exec(c);
        if (m) {
          const found = !state.failVerify && state.categories.some((c) => c.name === m[1] && c.vars.some(([k, v]) => k === "type" && v === "endpoint"));
          return cli(found ? `Endpoint:  ${m[1]}\nAor:  ${m[1]}` : `Unable to find object ${m[1]}.`);
        }
        return err(`No such command '${c}'`);
      }
      default:
        return err(`Invalid/unknown command: ${req.Action}`);
    }
  }

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  state.port = server.address().port;
  state.close = async () => {
    for (const s of state.sockets) s.destroy();
    await new Promise((r) => server.close(r));
  };
  /** Requests after login, optionally filtered by Action. */
  state.actions = (name) => state.received.filter((r) => r.Action !== "Login" && (!name || r.Action === name));
  return state;
}
