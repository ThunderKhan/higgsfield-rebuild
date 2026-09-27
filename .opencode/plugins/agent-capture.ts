import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const PROJECT = "higgsfield-rebuild"
const AUTHOR = "ThunderKhan"
const TOOL_NAME = "opencode"
const LOG_DIR = ".agent-logs"
const MARKER = path.join(os.tmpdir(), "opencode-agent-capture.init.log")

const timers = new Map()
const chains = new Map()
const sessionCache = new Map()

function mark(text) {
  try {
    fs.appendFileSync(MARKER, new Date().toISOString() + " " + text + "\n")
  } catch (error) {
    void error
  }
}

function pad2(value) {
  return String(value).padStart(2, "0")
}

function utcDate(ms) {
  const d = new Date(ms)
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate())
}

function utcFile(ms) {
  const d = new Date(ms)
  return (
    utcDate(ms) +
    "_" +
    pad2(d.getUTCHours()) +
    "-" +
    pad2(d.getUTCMinutes()) +
    "-" +
    pad2(d.getUTCSeconds())
  )
}

function iso(ms) {
  return new Date(ms).toISOString()
}

function textOf(parts) {
  if (!Array.isArray(parts)) return ""
  const out = []
  for (const part of parts) {
    if (!part || part.type !== "text") continue
    if (part.synthetic || part.ignored) continue
    if (typeof part.text !== "string" || part.text.length === 0) continue
    out.push(part.text)
  }
  return out.join("\n\n")
}

function modelOf(info) {
  if (info && info.model && info.model.providerID) {
    return info.model.providerID + "/" + info.model.modelID
  }
  if (info && info.providerID) return info.providerID + "/" + info.modelID
  if (info && info.modelID) return info.modelID
  return "unknown"
}

function entry(type, num, sessionID, timestamp, model, body) {
  return (
    "[LOG_ENTRY type=" +
    type +
    " num=" +
    num +
    " session=" +
    sessionID +
    "]\n" +
    "timestamp: " +
    timestamp +
    "\n" +
    "model: " +
    model +
    "\n\n" +
    body +
    "\n\n\n"
  )
}

function frontmatter(fields) {
  return (
    "---\n" +
    "session_id: " +
    fields.sessionID +
    "\n" +
    "date: " +
    fields.date +
    "\n" +
    "author: " +
    AUTHOR +
    "\n" +
    "model: " +
    fields.model +
    "\n" +
    "tool: " +
    TOOL_NAME +
    "\n" +
    "project: " +
    PROJECT +
    "\n" +
    "total_exchanges: " +
    fields.total +
    "\n" +
    "first_prompt_time: " +
    fields.first +
    "\n" +
    "last_prompt_time: " +
    fields.last +
    "\n" +
    "---\n"
  )
}

function titleBlock(date, sessionID) {
  return (
    "\n# Session Log - " +
    date +
    "\n\nSession: `" +
    sessionID.slice(0, 8) +
    "` | Project: `" +
    PROJECT +
    "` | Author: `" +
    AUTHOR +
    "`\n\n---\n\n"
  )
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function entryRegex(sessionID) {
  return new RegExp(
    "^\\[LOG_ENTRY type=(PROMPT|RESPONSE) num=(\\d+) session=" + escapeRe(sessionID) + "\\]\\r?\\ntimestamp: (\\S+)\\r?\\nmodel: (\\S+)",
    "gm",
  )
}

function statsOf(body, sessionID) {
  const promptTimes = []
  const models = []
  const present = new Set()
  const re = entryRegex(sessionID)
  let match
  while ((match = re.exec(body)) !== null) {
    present.add(match[1] + ":" + match[2])
    if (match[1] === "PROMPT") promptTimes.push(match[3])
    models.push(match[4])
  }
  let prompts = 0
  let responses = 0
  for (const key of present) {
    if (key.startsWith("PROMPT:")) prompts += 1
    else responses += 1
  }
  return {
    present,
    prompts,
    responses,
    first: promptTimes[0] || "",
    last: promptTimes[promptTimes.length - 1] || "",
    model: models[models.length - 1] || "",
  }
}

function splitFile(content) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(content)
  if (!match) return null
  return { head: match[0], tail: content.slice(match[0].length) }
}

function readLog(file, sessionID) {
  if (!fs.existsSync(file)) return null
  const content = fs.readFileSync(file, "utf8")
  const parts = splitFile(content)
  if (!parts) return null
  const dateMatch = /date: (\S+)/.exec(parts.head)
  return {
    head: parts.head,
    tail: parts.tail,
    date: dateMatch ? dateMatch[1] : "",
    stats: statsOf(parts.tail, sessionID),
  }
}

function locateLog(dir, sessionID, fallbackName) {
  const preferred = path.join(dir, fallbackName)
  if (fs.existsSync(preferred)) return preferred
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".md")) continue
      const candidate = path.join(dir, name)
      try {
        const head = fs.readFileSync(candidate, "utf8").slice(0, 512)
        if (head.indexOf("session_id: " + sessionID) !== -1) return candidate
      } catch (error) {
        void error
      }
    }
  } catch (error) {
    void error
  }
  return preferred
}

async function getSession(client, sessionID) {
  if (sessionCache.has(sessionID)) return sessionCache.get(sessionID)
  let info = null
  try {
    const res = await client.session.get({ path: { id: sessionID } })
    info = res && res.data ? res.data : null
  } catch (error) {
    mark("session lookup failed " + sessionID + " " + String(error))
    info = null
  }
  sessionCache.set(sessionID, info)
  return info
}

async function sweep(root, client, sessionID) {
  const session = await getSession(client, sessionID)
  if (!session) return
  if (session.parentID) return

  let messages = []
  try {
    const res = await client.session.messages({ path: { id: sessionID }, query: { limit: 1000 } })
    messages = res && Array.isArray(res.data) ? res.data : []
  } catch (error) {
    mark("messages failed " + sessionID + " " + String(error))
    return
  }

  const plan = []
  let carry = null
  for (const item of messages) {
    const info = item && item.info ? item.info : null
    if (!info) continue
    if (info.role === "user") {
      if (carry) plan.push(carry)
      carry = { prompt: item, response: null }
    } else if (info.role === "assistant") {
      if (carry) carry.response = item
    }
  }
  if (carry) plan.push(carry)

  const created = session.time && session.time.created ? session.time.created : Date.now()
  const dir = path.join(root, LOG_DIR)
  const file = locateLog(dir, sessionID, utcFile(created) + "_" + sessionID + ".md")
  const existing = readLog(file, sessionID)
  const present = existing ? existing.stats.present : new Set()

  const chunks = []
  let promptIndex = 0
  let responseIndex = 0
  for (const pair of plan) {
    const promptInfo = pair.prompt.info
    const promptBody = textOf(pair.prompt.parts)
    promptIndex += 1
    if (promptBody && !present.has("PROMPT:" + promptIndex)) {
      const ts = promptInfo.time && promptInfo.time.created ? promptInfo.time.created : Date.now()
      chunks.push(entry("PROMPT", promptIndex, sessionID, iso(ts), modelOf(promptInfo), promptBody))
    }
    if (pair.response) {
      const responseInfo = pair.response.info
      const responseBody = textOf(pair.response.parts)
      responseIndex += 1
      if (responseBody && !present.has("RESPONSE:" + responseIndex)) {
        const time = responseInfo.time || {}
        const ts = time.completed || time.created || Date.now()
        chunks.push(entry("RESPONSE", responseIndex, sessionID, iso(ts), modelOf(responseInfo), responseBody))
      }
    }
  }

  if (chunks.length === 0) return

  const appended = (existing ? existing.tail : "") + chunks.join("")
  const stats = statsOf(appended, sessionID)
  const date =
    existing && existing.date
      ? existing.date
      : stats.first
        ? utcDate(Date.parse(stats.first))
        : utcDate(created)
  const tail = existing ? existing.tail : titleBlock(date, sessionID)
  const content =
    frontmatter({
      sessionID,
      date,
      model: stats.model || "unknown",
      total: stats.prompts,
      first: stats.first || "unknown",
      last: stats.last || "unknown",
    }) +
    tail +
    chunks.join("")

  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, content, "utf8")
    mark("wrote " + path.basename(file) + " +" + chunks.length)
  } catch (error) {
    mark("write failed " + sessionID + " " + String(error))
  }
}

export const AgentCapture = async (input) => {
  const root = input.directory
  const client = input.client
  mark("load root=" + root)

  const run = (sessionID, delay) => {
    const key = sessionID
    const previous = timers.get(key)
    if (previous) clearTimeout(previous)
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        const tail = chains.get(key) || Promise.resolve()
        const next = tail
          .catch(() => undefined)
          .then(() => sweep(root, client, sessionID))
          .catch((error) => mark("sweep failed " + sessionID + " " + String(error)))
        chains.set(key, next)
      }, delay),
    )
  }

  return {
    config: async () => {
      mark("config root=" + root)
    },
    event: async ({ event }) => {
      if (event.type === "session.idle" || event.type === "session.error") {
        const sessionID = event.properties && event.properties.sessionID
        if (sessionID) run(sessionID, 250)
        return
      }
      if (event.type !== "message.updated") return
      const info = event.properties && event.properties.info
      if (!info || !info.sessionID) return
      const done = info.role === "assistant" && info.time && info.time.completed
      run(info.sessionID, done ? 400 : 900)
    },
    dispose: async () => {
      mark("dispose root=" + root)
    },
  }
}
