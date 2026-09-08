import { imageFixture } from "./provider-e2e-fixtures.mjs"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  realpath,
  symlink,
  unlink,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
if (!process.versions.electron) {
  const root = await mkdtemp(join(tmpdir(), "mako-provider-e2e-"))
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "mako-e2e", main: fileURLToPath(import.meta.url) })
  )
  for (const name of ["node_modules", "dist-electron", "scripts"])
    await symlink(join(repo, name), join(root, name), "dir")
  const child = spawn(
    join(repo, "node_modules/.bin/electron"),
    [root, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: { ...process.env, MAKO_E2E_ROOT: root },
    }
  )
  child.on("exit", (code) => {
    process.exitCode = code ?? 1
  })
} else {
  void runElectron().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}

async function runElectron() {
  const { app } = await import("electron")
  const root = process.env.MAKO_E2E_ROOT
  if (!root) throw new Error("Launch this test with Node")
  await mkdir(join(root, "user-data"))
  app.setPath("userData", join(root, "user-data"))
  await app.whenReady()
  const { LiveConversations } =
    await import("../dist-electron/live-conversations.js")
  const { providerHost } = await import("../dist-electron/providers/index.js")
  const { bindAcp, stopAcp } = await import("../dist-electron/acp.js")
  const { bindCodexApp, stopCodexApps } =
    await import("../dist-electron/codex-app.js")
  const { startConversationMcp } =
    await import("../dist-electron/conversation-mcp.js")
  const { defaultCatalog } = await import("@mako/sessions")
  const { nativeCheckpoint, canResumeBinding } =
    await import("../dist-electron/native-continuation.js")
  const catalog = defaultCatalog()
  const { BrowserService } = await import("../dist-electron/browser-service.js")
  const { startControlService } =
    await import("../dist-electron/control-service.js")
  const { extensionBrowsers } = await import("../dist-electron/browser-extension-registration.js")
  const browser = new BrowserService(process.env.MAKO_E2E_BROWSER_REGISTRATION_ROOT
    ? extensionBrowsers(process.env.MAKO_E2E_BROWSER_REGISTRATION_ROOT)
    : undefined)
  const browserOperations = []
  const executeBrowser = browser.execute.bind(browser)
  browser.execute = async (conversationId, command, ...args) => {
    const value = await executeBrowser(conversationId, command, ...args)
    browserOperations.push({ conversationId, action: command.action })
    return value
  }
  let control
  let mcp
  const dependencies = {
    root: join(root, "journals"),
    appPath: root,
    driver: (provider) => providerHost.liveDrivers.get(provider),
    providers: () =>
      providerHost.liveDrivers.list().map((driver) => driver.provider),
    tools: (binding, id) => {
      const conversation = mcp?.mint(binding, id)
      return conversation
        ? { ...conversation, control: control?.mint(id, binding) }
        : undefined
    },
    history: (path, before) => catalog.page(path, before),
    checkpoint: nativeCheckpoint,
    canResume: (binding) =>
      canResumeBinding(
        binding,
        providerHost.processProbes.get(binding.provider)
      ),
    emit: () => {},
  }
  let owner = new LiveConversations(dependencies)
  bindAcp((event) => owner.observe(event))
  bindCodexApp((event) => owner.observe(event))
  mcp = await startConversationMcp(owner)
  control = await startControlService(browser, (id, binding) =>
    owner.authorizeAgent(id, binding)
  )
  const models = JSON.parse(process.env.MAKO_E2E_MODELS ?? "{}")
  const results = []
  const delegationParents = new Set()
  const delegationChildren = new Set()
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
  const drivers = providerHost.liveDrivers
    .list()
    .filter(
      (driver) => !requested.length || requested.includes(driver.provider)
    )
  async function waitFor(id, predicate, milliseconds = 180_000) {
    const deadline = Date.now() + milliseconds
    while (Date.now() < deadline) {
      const snapshot = owner.snapshot(id)
      if (snapshot?.permissions.length) {
        const reads = snapshot.blocks.filter(
          (block) =>
            block.type === "tool" &&
            block.toolKind === "read" &&
            block.status === "pending"
        )
        const grantedFiles = [
          ...snapshot.requests.flatMap((request) =>
            request.attachments.flatMap((attachment) =>
              attachment.path ? [attachment.path] : []
            )
          ),
          ...snapshot.requests
            .flatMap((request) => request.context ?? [])
            .flatMap((manifest) => [
              manifest.file,
              ...(manifest.resources ?? []),
            ]),
        ]
        for (const permission of snapshot.permissions) {
          const once = permission.options.find(
            (option) => option.kind === "allow_once"
          )
          const fixtureRead =
            permission.title === "Read File" &&
            reads.some((block) =>
              grantedFiles.some((file) => block.input?.includes(file))
            )
          const capabilitiesRead =
            permission.title ===
            "mcp__mako-conversations__mako_conversation_capabilities"
          const fixtureDelegation =
            delegationParents.has(id) &&
            permission.title ===
              'mako-conversations: Allow the mako-conversations MCP server to run tool "mako_delegate_task"?'
          const fixtureChildWrite =
            delegationChildren.has(id) &&
            permission.title ===
              `Write ${join(await realpath(snapshot.session.cwd), "proof.txt")}`
          if (
            !once ||
            (!fixtureRead &&
              !capabilitiesRead &&
              !fixtureDelegation &&
              !fixtureChildWrite)
          )
            throw new Error(
              `Permission outside the fixture read grant: ${permission.title}`
            )
          await owner.permission(id, permission.id, {
            kind: "choice",
            optionId: once.optionId,
          })
        }
      }
      if (predicate(snapshot)) return snapshot
      if (snapshot?.session.status === "failed")
        throw new Error(snapshot.session.error ?? "Provider failed")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error("Provider did not complete within the test deadline")
  }
  try {
    for (const driver of process.argv.includes("--browser-only")
      ? []
      : drivers) {
      const result = {
        provider: driver.provider,
        available: driver.available(root),
        status: "pending",
      }
      results.push(result)
      if (!result.available) {
        result.status = "unavailable"
        console.log(JSON.stringify(result))
        continue
      }
      const id = randomUUID()
      const cwd = join(root, driver.provider)
      await mkdir(cwd)
      const nonce = randomUUID()
      await writeFile(
        join(cwd, "proof.txt"),
        `The fixture value is ${nonce}.\n`
      )
      console.log(`Testing installed ${driver.provider} through Mako`)
      try {
        await owner.start(driver.provider, cwd, {
          conversationId: id,
          title: "Mako disposable E2E fixture",
          tuning:
            (process.env.MAKO_E2E_MODEL ?? models[driver.provider])
              ? { model: process.env.MAKO_E2E_MODEL ?? models[driver.provider] }
              : undefined,
        })
        await waitFor(
          id,
          (snapshot) => snapshot?.session.status === "ready",
          60_000
        )
        const requestId = randomUUID()
        owner.submit(
          id,
          requestId,
          "Read proof.txt in this workspace using your file tool. Reply with only the fixture value. This is an authorized disposable integration test. Do not modify files."
        )
        const completed = await waitFor(id, (snapshot) =>
          snapshot?.requests.some(
            (request) =>
              request.id === requestId && request.status === "completed"
          )
        )
        const response = completed.blocks
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
        if (!response.includes(nonce))
          throw new Error(
            "The real response did not contain the value from the fixture file"
          )
        result.status = "passed"
        result.nativeId = completed.session.nativeId
        result.toolCalls = completed.blocks
          .filter((block) => block.type === "tool")
          .map((block) => block.title)
        result.proof = nonce
        await writeFile(
          join(root, `${driver.provider}.json`),
          JSON.stringify(completed, null, 2)
        )
      } catch (error) {
        result.status = "failed"
        result.error = error instanceof Error ? error.message : String(error)
        const snapshot = owner.snapshot(id)
        if (snapshot)
          await writeFile(
            join(root, `${driver.provider}.json`),
            JSON.stringify(snapshot, null, 2)
          )
      } finally {
        if (owner.snapshot(id)) owner.close(id)
      }
      console.log(JSON.stringify(result))
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
    }
    if (
      process.argv.includes("--browser") ||
      process.argv.includes("--browser-only")
    ) {
      const { runBrowserFixture } = await import("./provider-e2e-browser.mjs")
      results.push(
        ...(await runBrowserFixture(
          owner,
          root,
          drivers.map((driver) => driver.provider),
          browserOperations,
          models
        ))
      )
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
    }
    if (process.argv.includes("--direct-attachments")) {
      const cwd = join(root, "direct-attachment-fixture")
      await mkdir(cwd)
      const id = randomUUID(),
        requestId = randomUUID(),
        proof = randomUUID()
      const picture = imageFixture(),
        file = Buffer.from(`FINAL_FIXTURE_VALUE=${proof}\n`)
      await owner.start("codex", cwd, {
        conversationId: id,
        title: "Mako direct attachment fixture",
      })
      await waitFor(id, (snapshot) => snapshot?.session.status === "ready")
      owner.submit(
        id,
        requestId,
        "Inspect the attached image and return RED=n BLUE=n for its red and blue square counts. Read the attached text file and return its FINAL_FIXTURE_VALUE.",
        [
          {
            name: "squares.png",
            mimeType: "image/png",
            size: picture.length,
            data: picture.toString("base64"),
          },
          {
            name: "value.txt",
            mimeType: "text/plain",
            size: file.length,
            data: file.toString("base64"),
          },
        ]
      )
      const completed = await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) =>
            request.id === requestId && request.status === "completed"
        )
      )
      const reply = completed.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
      if (
        !/RED\s*=\s*4/i.test(reply) ||
        !/BLUE\s*=\s*2/i.test(reply) ||
        !reply.includes(proof)
      )
        throw new Error(`Direct attachment delivery failed: ${reply}`)
      results.push({ flow: "direct-image-and-file", status: "passed", proof })
      console.log("Real direct image and file attachment delivery passed")
      await writeFile(
        join(root, "direct-attachments.json"),
        JSON.stringify(completed, null, 2)
      )
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
      owner.close(id)
    }
    if (process.argv.includes("--remote")) {
      const { runRelayFixture } = await import("./provider-e2e-relay.mjs")
      const result = await runRelayFixture(owner, root)
      results.push(result)
      console.log(JSON.stringify(result))
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
    }
    if (process.argv.includes("--attachments")) {
      const cwd = join(root, "attachment-fixture")
      await mkdir(cwd)
      const proof = randomUUID()
      const picture = imageFixture()
      const artifact = Buffer.from(
        `${"Fixture padding.\n".repeat(20_000)}FINAL_FIXTURE_VALUE=${proof}\n`
      )
      await writeFile(join(cwd, "squares.png"), picture)
      await writeFile(join(cwd, "large.txt"), artifact)
      const attachments = [
        {
          name: "squares.png",
          mimeType: "image/png",
          size: picture.length,
          data: picture.toString("base64"),
        },
        {
          name: "large.txt",
          mimeType: "text/plain",
          size: artifact.length,
          data: artifact.toString("base64"),
        },
      ]
      const id = randomUUID()
      await owner.start("claude", cwd, {
        conversationId: id,
        title: "Mako attachment transfer fixture",
      })
      await waitFor(id, (snapshot) => snapshot?.session.status === "ready")
      const initial = randomUUID()
      owner.submit(
        id,
        initial,
        "These are fixtures for a later request. Reply only READY. Do not describe the image or read the text file yet.",
        attachments
      )
      await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) => request.id === initial && request.status === "completed"
        )
      )
      await unlink(join(cwd, "squares.png"))
      await unlink(join(cwd, "large.txt"))
      const before = owner.snapshot(id).blocks.length
      const requestId = randomUUID()
      owner.transfer(id, {
        id: requestId,
        provider: "codex",
        text: "Read the transferred attachment files. Open and inspect squares.png using your image tool. Return the number of red and blue squares as RED=n BLUE=n. Read the very end of large.txt and return its FINAL_FIXTURE_VALUE. The original workspace copies have been deleted, so use the retained resources in the context bundle.",
        attachments: [],
      })
      const completed = await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) =>
            request.id === requestId && request.status === "completed"
        )
      )
      const added = completed.blocks.slice(before)
      const reply = added
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
      if (
        !/RED\s*=\s*4/i.test(reply) ||
        !/BLUE\s*=\s*2/i.test(reply) ||
        !reply.includes(proof)
      )
        throw new Error(`Attachment transfer failed: ${reply}`)
      const tools = added
        .filter((block) => block.type === "tool")
        .map((block) => block.title)
      results.push({
        flow: "real-attachment-transfer",
        status: "passed",
        proof,
        bytes: artifact.length,
        tools,
      })
      console.log(
        "Real image inspection and large artifact tail retrieval passed after original file deletion"
      )
      await writeFile(
        join(root, "attachments.json"),
        JSON.stringify(completed, null, 2)
      )
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
      owner.close(id)
    }
    if (process.argv.includes("--delegate")) {
      const cwd = join(root, "delegation-fixture")
      await mkdir(cwd)
      const parentValue = randomUUID()
      const childValue = randomUUID()
      await writeFile(join(cwd, "proof.txt"), parentValue)
      const id = randomUUID()
      const childId = randomUUID()
      await owner.start("codex", cwd, {
        conversationId: id,
        title: "Mako model delegation fixture",
      })
      await waitFor(id, (snapshot) => snapshot?.session.status === "ready")
      delegationParents.add(id)
      delegationChildren.add(childId)
      owner.submit(
        id,
        randomUUID(),
        `This is an explicitly authorized delegation integration test. Call mako_delegate_task with id ${childId}, provider claude, and task: "Read proof.txt. Replace its contents with ${childValue}. Report the original and new value. This is your isolated disposable workspace." Do not perform the child task yourself. After delegating, end your response. When the child's result arrives, report both values.`
      )
      await waitFor(id, () => Boolean(owner.snapshot(childId)))
      const child = await waitFor(childId, (snapshot) =>
        snapshot?.requests.some((request) => request.status === "completed")
      )
      if (child.session.cwd === cwd)
        throw new Error("Delegated child shared the parent workspace")
      if ((await readFile(join(cwd, "proof.txt"), "utf8")) !== parentValue)
        throw new Error("Child modified the parent workspace")
      if (
        (
          await readFile(join(child.session.cwd, "proof.txt"), "utf8")
        ).trim() !== childValue
      )
        throw new Error("Child did not perform its isolated write")
      const completed = await waitFor(
        id,
        (snapshot) =>
          snapshot?.control.children.some(
            (child) => child.id === childId && child.delivery === "delivered"
          ) && snapshot.session.status === "ready"
      )
      const reply = completed.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
      if (!reply.includes(childValue) || !reply.includes(parentValue))
        throw new Error("Parent did not receive the actual child result")
      const calls = completed.blocks.filter((block) => block.type === "tool")
      if (!JSON.stringify(calls).includes("mako_delegate_task"))
        throw new Error("Parent did not call the delegation tool")
      results.push({
        flow: "model-delegation",
        status: "passed",
        parent: id,
        child: childId,
        parentValue,
        childValue,
        workspace: child.session.cwd,
      })
      console.log(
        "Real model delegation, isolated child write and parent result delivery passed"
      )
      await writeFile(
        join(root, "delegation.json"),
        JSON.stringify({ parent: completed, child }, null, 2)
      )
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
      owner.close(id)
      owner.close(childId)
    }
    if (process.argv.includes("--restart")) {
      const cwd = join(root, "restart-fixture")
      await mkdir(cwd)
      const id = randomUUID()
      const proof = randomUUID()
      await owner.start("codex", cwd, {
        conversationId: id,
        title: "Mako restart fixture",
      })
      await waitFor(id, (snapshot) => snapshot?.session.status === "ready")
      const initial = randomUUID()
      owner.submit(
        id,
        initial,
        `Remember this fixture value: ${proof}. Reply with the value only.`
      )
      const source = await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) => request.id === initial && request.status === "completed"
        )
      )
      const refs = await catalog.scan()
      const ref = refs.find(
        (ref) =>
          ref.harness === "codex" && ref.nativeId === source.session.nativeId
      )
      if (!ref) throw new Error("Exact native session ID was not discoverable")
      await owner.bind(id, ref.path)
      await waitFor(id, (snapshot) =>
        snapshot?.control.bindings.some((binding) => binding.checkpoint)
      )
      const binding = owner
        .snapshot(id)
        .control.bindings.find(
          (binding) => binding.nativeId === source.session.nativeId
        )
      owner.stop()
      stopCodexApps()
      mcp.close()
      const deadline = Date.now() + 30_000
      while (!(await dependencies.canResume(binding))) {
        if (Date.now() > deadline)
          throw new Error("Native session did not become safe to resume")
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      owner = new LiveConversations(dependencies)
      mcp = await startConversationMcp(owner)
      const requestId = randomUUID()
      owner.submit(
        id,
        requestId,
        "What exact fixture value did I ask you to remember? Return the value only."
      )
      const completed = await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) =>
            request.id === requestId && request.status === "completed"
        )
      )
      if (completed.session.nativeId !== source.session.nativeId)
        throw new Error("Restart did not reuse the verified native ID")
      const reply = completed.blocks
        .slice(source.blocks.length)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
      if (!reply.includes(proof))
        throw new Error("Resumed provider lost native history")
      const request = completed.requests.find(
        (request) => request.id === requestId
      )
      if (
        request.context.some(
          (manifest) =>
            manifest.includesBase || manifest.fromBlock !== source.blocks.length
        )
      )
        throw new Error("Restart silently used full portable context")
      results.push({
        flow: "native-restart",
        provider: "codex",
        status: "passed",
        nativeId: completed.session.nativeId,
        proof,
      })
      console.log(
        "Real native restart passed with unchanged native ID and no portable history"
      )
      await writeFile(
        join(root, "restart.json"),
        JSON.stringify(completed, null, 2)
      )
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
      owner.close(id)
    }
    if (process.argv.includes("--fork")) {
      const cwd = join(root, "fork-fixture")
      await mkdir(cwd)
      const id = randomUUID()
      const proof = randomUUID()
      await owner.start("codex", cwd, {
        conversationId: id,
        title: "Mako native fork fixture",
      })
      await waitFor(id, (snapshot) => snapshot?.session.status === "ready")
      const requestId = randomUUID()
      owner.submit(
        id,
        requestId,
        `Remember this fixture value: ${proof}. Reply with that value only.`
      )
      const source = await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) =>
            request.id === requestId && request.status === "completed"
        )
      )
      const laterId = randomUUID()
      const laterProof = randomUUID()
      owner.submit(
        id,
        laterId,
        `Replace the fixture value with ${laterProof}. Reply with this new value only.`
      )
      await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) => request.id === laterId && request.status === "completed"
        )
      )
      const nativeRuns = owner
        .snapshot(id)
        .requests.filter((request) => request.status === "completed")
        .map((request) => request.nativeRun?.runId)
      if (new Set(nativeRuns).size !== 2 || nativeRuns.some((run) => !run))
        throw new Error(
          "Distinct source turns did not retain distinct native run IDs"
        )
      const forkId = randomUUID()
      const fork = owner.fork(id, {
        id: forkId,
        provider: "codex",
        point: { kind: "run", requestId },
      })
      if (!fork.control.ancestry.nativeFork)
        throw new Error("Native fork point missing")
      if (fork.session.nativeId)
        throw new Error("Fork allocated before first send")
      const continuation = randomUUID()
      owner.submit(
        forkId,
        continuation,
        "What exact fixture value did I just ask you to remember? Reply with that value only."
      )
      const completed = await waitFor(forkId, (snapshot) =>
        snapshot?.requests.some(
          (request) =>
            request.id === continuation && request.status === "completed"
        )
      )
      const reply = completed.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
      if (!reply.includes(proof) || reply.includes(laterProof))
        throw new Error(
          "Native fork lost the selected turn or included a later turn"
        )
      if (completed.session.nativeId === source.session.nativeId)
        throw new Error("Fork reused source native ID")
      if (
        completed.requests[0].context.some((manifest) => manifest.includesBase)
      )
        throw new Error(
          "Native fork test accidentally supplied portable history"
        )
      results.push({
        flow: "native-fork",
        provider: "codex",
        status: "passed",
        source: source.session.nativeId,
        fork: completed.session.nativeId,
        proof,
      })
      console.log("Real native fork passed without portable history")
      await writeFile(
        join(root, "fork.json"),
        JSON.stringify(completed, null, 2)
      )
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
      owner.close(id)
      owner.close(forkId)
    }
    if (process.argv.includes("--flows")) {
      const cwd = join(root, "transfer-fixture")
      await mkdir(cwd)
      const proof = randomUUID()
      await writeFile(join(cwd, "proof.txt"), proof)
      const id = randomUUID()
      await owner.start("claude", cwd, {
        conversationId: id,
        title: "Mako real transfer fixture",
      })
      await waitFor(id, (snapshot) => snapshot?.session.status === "ready")
      const initial = randomUUID()
      owner.submit(
        id,
        initial,
        "Read proof.txt and report its exact value. Do not modify anything."
      )
      await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) => request.id === initial && request.status === "completed"
        )
      )
      await unlink(join(cwd, "proof.txt"))
      for (const provider of ["codex", "claude"]) {
        const previous = owner.snapshot(id)
        const requestId = randomUUID()
        owner.transfer(id, {
          id: requestId,
          provider,
          text: "What exact fixture value did the preceding provider report? Read the supplied context and return that value only. The original file has been deleted.",
          attachments: [],
        })
        const completed = await waitFor(id, (snapshot) =>
          snapshot?.requests.some(
            (request) =>
              request.id === requestId && request.status === "completed"
          )
        )
        const added = completed.blocks.slice(previous.blocks.length)
        const reply = added
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
        if (!reply.includes(proof))
          throw new Error(
            `${provider} failed to recover the value through transferred context`
          )
        const result = {
          flow: "real-transfer",
          provider,
          status: "passed",
          conversationId: id,
          nativeId: completed.session.nativeId,
          proof,
          tools: added
            .filter((block) => block.type === "tool")
            .map((block) => block.title),
        }
        results.push(result)
        console.log(JSON.stringify(result))
        await writeFile(
          join(root, "transfer.json"),
          JSON.stringify(completed, null, 2)
        )
      }
      const beforeMcp = owner.snapshot(id).blocks.length
      const mcpRequest = randomUUID()
      owner.submit(
        id,
        mcpRequest,
        "Call the mako_conversation_capabilities MCP tool now. Return the provider IDs it reports. This is an explicitly authorized integration check."
      )
      const completed = await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) =>
            request.id === mcpRequest && request.status === "completed"
        )
      )
      const calls = completed.blocks
        .slice(beforeMcp)
        .filter((block) => block.type === "tool")
      if (!JSON.stringify(calls).includes("mako_conversation_capabilities"))
        throw new Error(
          "The model did not invoke the real conversation MCP tool"
        )
      results.push({
        flow: "model-mcp-call",
        status: "passed",
        tools: calls.map((block) => block.title),
      })
      console.log("Actual model MCP call passed")
      await writeFile(
        join(root, "transfer.json"),
        JSON.stringify(completed, null, 2)
      )
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
    }
    console.log(`Evidence: ${root}`)
    process.exitCode = results.some((result) => result.status === "failed")
      ? 1
      : 0
  } finally {
    for (const summary of owner.summaries()) {
      const snapshot = owner.snapshot(summary.session.id)
      if (snapshot)
        await writeFile(
          join(root, `snapshot-${summary.session.id}.json`),
          JSON.stringify(snapshot, null, 2)
        )
    }
    console.log(`Evidence retained: ${root}`)
    owner.stop()
    stopAcp()
    stopCodexApps()
    mcp.close()
    control.close()
    await catalog.stop()
    app.exit(process.exitCode ?? 0)
  }
}
