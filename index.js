#!/usr/bin/env node
/**
 * Storybook MCP Server
 * 
 * A dynamic MCP server that uses Playwright to browse and extract documentation
 * from any Storybook site. Connect to any Storybook URL at runtime.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import playwright from "playwright";
import TurndownService from "turndown";

// ============================================================================
// StorybookBrowser – connects to a Storybook site and fetches docs/stories
// ============================================================================

class StorybookBrowser {
  constructor(config) {
    this.config = { headless: true, timeout: 30000, ...config };
    this.browser = null;
    this.context = null;
    this.page = null;
    this.storybookInfo = null;
    this.cachedNavigation = null;
    this.navigationCacheTime = 0;
    this.CACHE_TTL = 5 * 60 * 1000;
    this.turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  }

  async initialize() {
    if (this.browser) return;
    this.browser = await playwright.chromium.launch({ headless: this.config.headless });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.config.timeout);
    await this.detectStorybookVersion();
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.storybookInfo = null;
      this.cachedNavigation = null;
      this.navigationCacheTime = 0;
    }
  }

  async ensurePageReady() {
    if (!this.page || !this.browser) throw new Error("Storybook browser not connected");
    try {
      await this.page.evaluate(() => true);
    } catch {
      this.context = await this.browser.newContext();
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(this.config.timeout);
    }
    return this.page;
  }

  async detectStorybookVersion() {
    if (this.storybookInfo) return this.storybookInfo;
    
    const page = this.page;
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    let hasIndexJson = false, usesStoryPath = false, version = "unknown";
    
    try {
      const indexUrl = baseUrl.replace("index.html", "").replace(/\/$/, "") + "/index.json";
      const response = await fetch(indexUrl);
      if (response.headers.get("content-type")?.includes("application/json") && response.ok) {
        const data = await response.json();
        hasIndexJson = true;
        version = data.v === 5 ? "v7" : data.v === 4 ? "v6" : (data.entries || data.stories) ? "v6" : "unknown";
      }
    } catch {}
    
    try {
      await this.safeNavigate(baseUrl);
      await page.waitForTimeout(2000);
      const currentUrl = page.url();
      usesStoryPath = currentUrl.includes("path=/story/") || currentUrl.includes("path=%2Fstory%2F");
      
      const sidebarLinks = await page.evaluate(() => 
        Array.from(document.querySelectorAll('a[href*="path="]')).slice(0, 5).map(l => l.getAttribute("href") || "")
      );
      if (sidebarLinks.some(href => href.includes("/story/"))) {
        usesStoryPath = true;
        if (!hasIndexJson) version = "v5";
      }
    } catch (e) {
      console.error("Error detecting Storybook version:", e);
    }
    
    this.storybookInfo = { version, hasIndexJson, usesStoryPath, usesIframeDocs: !usesStoryPath && hasIndexJson };
    console.error(`Detected Storybook: version=${version}, hasIndexJson=${hasIndexJson}, usesStoryPath=${usesStoryPath}`);
    return this.storybookInfo;
  }

  async safeNavigate(url) {
    const page = await this.ensurePageReady();
    const strategies = ["domcontentloaded", "load", "networkidle"];
    let lastError = null;
    
    for (const waitUntil of strategies) {
      try {
        await page.goto(url, { waitUntil, timeout: this.config.timeout });
        return;
      } catch (e) {
        lastError = e;
        if (e.message?.includes("net::ERR_ABORTED") || e.message?.includes("Timeout")) continue;
        throw e;
      }
    }
    
    try {
      await page.goto(url, { waitUntil: "commit", timeout: this.config.timeout });
      await page.waitForTimeout(3000);
    } catch {
      throw lastError || new Error(`Failed to navigate to ${url}`);
    }
  }

  buildStoryUrl(storyId, mode = "docs") {
    const baseUrl = this.config.baseUrl.replace("index.html", "").replace(/\?.*$/, "").replace(/\/$/, "");
    let cleanId = storyId.replace(/^\/story\//, "").replace(/^\/docs\//, "").replace(/^\//, "");
    
    if (this.storybookInfo?.usesStoryPath || this.storybookInfo?.version === "v5") {
      return `${baseUrl}/iframe.html?id=${cleanId}`;
    }
    
    const viewMode = mode === "docs" || cleanId.includes("--docs") ? "docs" : "story";
    if (viewMode === "docs" && !cleanId.includes("--docs") && !cleanId.includes("--color")) {
      cleanId = cleanId + "--docs";
    }
    return `${baseUrl}/iframe.html?viewMode=${viewMode}&id=${cleanId}`;
  }

  async discoverNavigation() {
    const page = await this.ensurePageReady();
    await this.safeNavigate(this.config.baseUrl);
    await page.waitForTimeout(3000);

    await page.evaluate(() => {
      document.querySelectorAll('button[aria-expanded="false"]').forEach(btn => btn.click());
      document.querySelectorAll('[data-nodetype="group"]').forEach(el => el.click());
    });
    await page.waitForTimeout(2000);

    const isOld = this.storybookInfo?.usesStoryPath || this.storybookInfo?.version === "v5";
    const navItems = await page.evaluate((isOldStorybook) => {
      const items = [];

      document.querySelectorAll('[data-item-id]').forEach(el => {
        const itemId = el.getAttribute("data-item-id") || "";
        const name = el.textContent?.trim() || "";
        if (name && itemId && !itemId.startsWith("group-")) {
          items.push({ name, storybookPath: itemId, type: itemId.includes("--docs") ? "docs" : "story" });
        }
      });

      document.querySelectorAll('a[href*="path="]').forEach(el => {
        const name = el.textContent?.trim() || "";
        const href = decodeURIComponent(el.getAttribute("href") || "");
        const pathMatch = href.match(/path=([^&]+)/);
        if (name && pathMatch) {
          let storyPath = pathMatch[1].replace("/story/", "").replace("/docs/", "");
          if (!items.some(i => i.storybookPath === storyPath)) {
            items.push({ name, storybookPath: storyPath, type: storyPath.includes("--docs") ? "docs" : "story" });
          }
        }
      });

      if (isOldStorybook || items.length < 10) {
        document.querySelectorAll('[data-name]').forEach(el => {
          const name = el.getAttribute("data-name") || el.textContent?.trim() || "";
          const href = el.href || "";
          const pathMatch = decodeURIComponent(href).match(/path=([^&]+)/);
          if (name && pathMatch) {
            const storyPath = pathMatch[1].replace("/story/", "").replace("/docs/", "");
            if (!items.some(i => i.storybookPath === storyPath)) {
              items.push({ name, storybookPath: storyPath, type: "story" });
            }
          }
        });
      }
      return items;
    }, isOld);

    if (navItems.length < 20) {
      try {
        const indexUrl = this.config.baseUrl.replace("index.html", "").replace(/\/$/, "") + "/index.json";
        const response = await fetch(indexUrl);
        if (response.headers.get("content-type")?.includes("application/json") && response.ok) {
          const data = await response.json();
          const entries = data.entries || data.stories || {};
          Object.entries(entries).forEach(([id, entry]) => {
            const type = entry.type || (id.includes("--docs") ? "docs" : "story");
            const name = entry.name || entry.title || id.split("--").pop() || id;
            if (!navItems.some(i => i.storybookPath === id)) {
              navItems.push({ name, storybookPath: id, type });
            }
          });
        }
      } catch {}
    }

    const categories = {};
    const flatList = [];

    navItems.forEach(item => {
      const navItem = { name: item.name, storybookPath: item.storybookPath, type: item.type };
      flatList.push(navItem);
      const path = (item.storybookPath || "").toLowerCase();
      let category = "other";
      if (path.includes("components-")) category = "components";
      else if (path.includes("getting-started-")) category = "getting-started";
      else if (path.includes("--")) category = path.split("--")[0] || "other";
      if (!categories[category]) categories[category] = [];
      categories[category].push(navItem);
    });

    return {
      categories: Object.entries(categories).map(([name, children]) => ({ name, storybookPath: null, type: "category", children })),
      flatList,
    };
  }

  async getPageContent(storybookPath, format = "structured") {
    const page = await this.ensurePageReady();
    const docId = storybookPath.replace(/^\/docs\//, "").replace(/^\/story\//, "").replace(/^\//, "");
    const iframeUrl = this.buildStoryUrl(docId, "docs");

    try {
      await this.safeNavigate(iframeUrl);
      await page.waitForTimeout(2000);

      const content = await page.evaluate(() => {
        const result = { title: "", description: "", sections: [], codeBlocks: [], tables: [], html: "" };
        const allH1s = document.querySelectorAll("h1");
        for (const h1 of allH1s) {
          const text = h1.textContent?.trim() || "";
          if (text && text !== "No Preview" && !text.includes("Sorry, but")) { result.title = text; break; }
        }
        document.querySelectorAll("pre code").forEach(codeEl => {
          const code = codeEl.textContent?.trim() || "";
          const language = codeEl.className.match(/language-(\w+)/)?.[1] || "html";
          if (code) result.codeBlocks.push({ language, code });
        });
        const body = document.body.cloneNode(true);
        [".sb-errordisplay", ".sb-preparing-story"].forEach(sel => body.querySelectorAll(sel).forEach(el => el.remove()));
        result.html = body.innerHTML;
        return result;
      });

      if (format === "markdown") {
        const rawMarkdown = this.cleanMarkdown(this.turndown.turndown(content.html));
        return { ...content, rawMarkdown };
      }
      return content;
    } catch (error) {
      console.error(`Failed to get page content for ${storybookPath}:`, error);
      return null;
    }
  }

  async getComponentDocs(storybookPath) {
    const page = await this.ensurePageReady();
    const docId = storybookPath.replace(/^\/docs\//, "").replace(/^\/story\//, "").replace(/^\//, "");
    const iframeUrl = this.buildStoryUrl(docId, "docs");

    try {
      await this.safeNavigate(iframeUrl);
      await page.waitForTimeout(2000);

      return await page.evaluate(() => {
        const result = { name: "", description: "", props: [], examples: [] };
        const allH1s = document.querySelectorAll("h1");
        for (const h1 of allH1s) {
          const text = h1.textContent?.trim() || "";
          if (text && text !== "No Preview") { result.name = text; break; }
        }
        document.querySelectorAll("pre code").forEach((codeEl, i) => {
          const code = codeEl.textContent?.trim() || "";
          if (code && code.length < 2000) result.examples.push({ title: `Example ${i + 1}`, code });
        });
        return result;
      });
    } catch (error) {
      console.error(`Failed to get component docs for ${storybookPath}:`, error);
      return null;
    }
  }

  async searchComponents(query) {
    const now = Date.now();
    if (!this.cachedNavigation || (now - this.navigationCacheTime) > this.CACHE_TTL) {
      this.cachedNavigation = await this.discoverNavigation();
      this.navigationCacheTime = now;
    }
    const lowerQuery = query.toLowerCase();
    return this.cachedNavigation.flatList.filter(item =>
      item.name.toLowerCase().includes(lowerQuery) || item.storybookPath?.toLowerCase().includes(lowerQuery)
    );
  }

  async takeScreenshot(storybookPath) {
    const page = await this.ensurePageReady();
    const docId = storybookPath.replace(/^\/docs\//, "").replace(/^\/story\//, "").replace(/^\//, "");
    const isStory = docId.includes("--") && !docId.includes("--docs");
    const iframeUrl = this.buildStoryUrl(docId, isStory ? "story" : "docs");
    await this.safeNavigate(iframeUrl);
    await page.waitForTimeout(2000);
    return await page.screenshot({ fullPage: true });
  }

  async getFullNavigation() {
    const baseUrl = this.config.baseUrl.replace("index.html", "").replace(/\/$/, "");
    let entries = {};

    try {
      const response = await fetch(baseUrl + "/index.json");
      if (response.headers.get("content-type")?.includes("application/json") && response.ok) {
        const data = await response.json();
        entries = data.entries || data.stories || {};
      } else throw new Error("index.json not available");
    } catch {
      const nav = await this.discoverNavigation();
      for (const item of nav.flatList) {
        if (item.storybookPath) {
          entries[item.storybookPath] = { type: item.type === "docs" ? "docs" : "story", name: item.name, title: item.name };
        }
      }
    }

    const nav = {};
    for (const [id, entry] of Object.entries(entries)) {
      const title = entry.title || id;
      const parts = title.split("/");
      const type = entry.type;
      const name = entry.name || id.split("--").pop() || "";
      const category = parts[0];
      const componentName = parts.length > 1 ? parts.slice(1).join("/") : parts[0];
      if (!nav[category]) nav[category] = {};
      if (!nav[category][componentName]) nav[category][componentName] = { docs: null, stories: [] };
      const storyEntry = { id, name, type, title };
      if (type === "docs") nav[category][componentName].docs = storyEntry;
      else if (type === "story") nav[category][componentName].stories.push(storyEntry);
    }

    const categories = [];
    let totalDocs = 0, totalStories = 0;
    for (const categoryName of Object.keys(nav).sort()) {
      const components = [];
      for (const [componentName, data] of Object.entries(nav[categoryName]).sort((a, b) => a[0].localeCompare(b[0]))) {
        if (data.docs) totalDocs++;
        totalStories += data.stories.length;
        components.push({ name: componentName, path: data.docs?.id || data.stories[0]?.id || "", docs: data.docs, stories: data.stories });
      }
      categories.push({ name: categoryName, components });
    }
    return { categories, totalDocs, totalStories, totalEntries: totalDocs + totalStories };
  }

  async getComponentEntries(componentPath) {
    const fullNav = await this.getFullNavigation();
    for (const category of fullNav.categories) {
      for (const component of category.components) {
        if (component.path.includes(componentPath) || component.name.toLowerCase().includes(componentPath.toLowerCase())) {
          return { component, category: category.name };
        }
      }
    }
    return { component: null, category: null };
  }

  async getStoryContent(storyId) {
    const page = await this.ensurePageReady();
    const cleanId = storyId.replace(/^\/story\//, "").replace(/^\/docs\//, "").replace(/^\//, "");
    const isDocsPage = cleanId.includes("--docs") || cleanId.includes("--color");
    const iframeUrl = this.buildStoryUrl(cleanId, isDocsPage ? "docs" : "story");

    try {
      await this.safeNavigate(iframeUrl);
      await page.waitForTimeout(2000);

      const content = await page.evaluate(() => {
        const result = { title: "", description: "", sections: [], codeBlocks: [], tables: [], html: "" };
        for (const h1 of document.querySelectorAll("h1")) {
          const text = h1.textContent?.trim() || "";
          if (text && text !== "No Preview") { result.title = text; break; }
        }
        document.querySelectorAll("pre code").forEach(codeEl => {
          const code = codeEl.textContent?.trim() || "";
          if (code && code.length < 5000) result.codeBlocks.push({ language: codeEl.className.match(/language-(\w+)/)?.[1] || "html", code });
        });
        result.html = document.body.innerHTML;
        return result;
      });

      const rawMarkdown = this.cleanMarkdown(this.turndown.turndown(content.html));
      return { ...content, rawMarkdown };
    } catch (error) {
      console.error(`Failed to get story content for ${storyId}:`, error);
      return null;
    }
  }

  cleanMarkdown(markdown) {
    const patterns = [/^Name\s*$/gm, /^Description\s*$/gm, /^Default\s*$/gm, /^Control\s*$/gm, /^Copy\s*$/gm, /# No Preview[\s\S]*?(?=# [A-Z])/g];
    let cleaned = markdown;
    patterns.forEach(p => { cleaned = cleaned.replace(p, ""); });
    return cleaned.replace(/\n{4,}/g, "\n\n\n").trim();
  }
}

// ============================================================================
// MCP Server
// ============================================================================

let storybookBrowser = null;
let currentStorybookUrl = (process.env.STORYBOOK_URL || "").trim() || null;
if (currentStorybookUrl && !isValidStorybookUrl(currentStorybookUrl)) currentStorybookUrl = null;

function isValidStorybookUrl(url) {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  try {
    const u = new URL(trimmed);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function getStorybookBrowser() {
  if (!currentStorybookUrl) throw new Error("No Storybook URL configured. Use the connect tool first with a url.");
  if (!storybookBrowser) {
    storybookBrowser = new StorybookBrowser({ baseUrl: currentStorybookUrl, headless: true, timeout: 30000 });
    await storybookBrowser.initialize();
  }
  return storybookBrowser;
}

async function reconnectStorybookBrowser(url) {
  if (!isValidStorybookUrl(url)) throw new Error("Invalid URL. Use a valid http or https Storybook URL.");
  if (storybookBrowser) { await storybookBrowser.close(); storybookBrowser = null; }
  currentStorybookUrl = url.trim();
  await getStorybookBrowser();
}

const TOOLS = [
  {
    name: "connect",
    description: "Connect to a Storybook URL and return connection status. Required before other tools.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Storybook URL (optional if already connected, will return current status)" }
      }
    }
  },
  {
    name: "list",
    description: "List components and stories in the Storybook navigation.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Filter by category name" },
        full: { type: "boolean", description: "Include full hierarchy with all stories (default: false for flat list)" }
      }
    }
  },
  {
    name: "search",
    description: "Search for components by name or path.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" }
      },
      required: ["query"]
    }
  },
  {
    name: "get_docs",
    description: "Get documentation, code examples, and content for a component or story.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Component path or story ID (e.g., 'components-button' or 'components-button--basic')" },
        full: { type: "boolean", description: "Include all story variations (default: false)" },
        format: { type: "string", enum: ["structured", "markdown"], description: "Output format (default: markdown)" }
      },
      required: ["path"]
    }
  },
  {
    name: "screenshot",
    description: "Take a screenshot of a component or story.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Component path or story ID" }
      },
      required: ["path"]
    }
  }
];

async function handleToolCall(name, args) {
  switch (name) {
    case "connect": {
      if (args.url) {
        try {
          await reconnectStorybookBrowser(args.url);
        } catch (error) {
          return { content: [{ type: "text", text: `Failed to connect: ${error}` }] };
        }
      }
      if (!currentStorybookUrl) {
        return { content: [{ type: "text", text: "Not connected. Provide a URL to connect." }] };
      }
      let info = `Connected to: ${currentStorybookUrl}\nReady: ${storybookBrowser !== null}`;
      if (storybookBrowser) {
        try {
          const versionInfo = await storybookBrowser.detectStorybookVersion();
          info += `\n\nStorybook Info:\n- Version: ${versionInfo.version}\n- Has index.json: ${versionInfo.hasIndexJson}\n- Uses /story/ paths: ${versionInfo.usesStoryPath}`;
        } catch {}
      }
      if (args.url) info = `Connected to: ${args.url}\n\n` + info.split("\n\n").slice(1).join("\n\n");
      return { content: [{ type: "text", text: info }] };
    }

    case "list": {
      const client = await getStorybookBrowser();
      if (args.full) {
        const fullNav = await client.getFullNavigation();
        let response = `# Navigation\n\n**URL:** ${currentStorybookUrl}\n**Total:** ${fullNav.totalDocs} docs + ${fullNav.totalStories} stories\n\n`;
        for (const cat of fullNav.categories) {
          if (args.category && !cat.name.toLowerCase().includes(args.category.toLowerCase())) continue;
          response += `## ${cat.name}\n\n`;
          for (const comp of cat.components) {
            response += `### ${comp.name}\n`;
            if (comp.docs) response += `- **Docs**: \`${comp.docs.id}\`\n`;
            comp.stories.forEach(s => { response += `- ${s.name}: \`${s.id}\`\n`; });
            response += "\n";
          }
        }
        return { content: [{ type: "text", text: response }] };
      }
      const nav = await client.discoverNavigation();
      let items = nav.flatList;
      if (args.category) items = items.filter(i => i.storybookPath?.toLowerCase().includes(args.category.toLowerCase()));
      let response = `# Storybook Navigation\n\n**URL:** ${currentStorybookUrl}\n**Total:** ${items.length}\n\n`;
      items.forEach(item => { response += `- ${item.name}: \`${item.storybookPath}\`\n`; });
      return { content: [{ type: "text", text: response }] };
    }

    case "search": {
      const client = await getStorybookBrowser();
      const results = await client.searchComponents(args.query);
      if (results.length === 0) return { content: [{ type: "text", text: `No results for "${args.query}"` }] };
      let response = `# Search: "${args.query}"\n\nFound ${results.length}:\n\n`;
      results.forEach(item => { response += `- **${item.name}** (${item.type}): \`${item.storybookPath}\`\n`; });
      return { content: [{ type: "text", text: response }] };
    }

    case "get_docs": {
      const client = await getStorybookBrowser();
      const path = args.path;
      const isStoryId = path.includes("--") && !path.endsWith("--docs");
      
      if (args.full) {
        const { component, category } = await client.getComponentEntries(path);
        if (!component) return { content: [{ type: "text", text: `Could not find: ${path}` }] };
        let response = `# ${component.name}\n\n**Category:** ${category}\n\n`;
        if (component.docs) response += `**Docs:** \`${component.docs.id}\`\n\n`;
        if (component.stories.length > 0) {
          response += `## Stories (${component.stories.length})\n\n`;
          component.stories.forEach(s => { response += `- ${s.name}: \`${s.id}\`\n`; });
        }
        return { content: [{ type: "text", text: response }] };
      }
      
      if (isStoryId) {
        const content = await client.getStoryContent(path);
        if (!content) return { content: [{ type: "text", text: `Could not load: ${path}` }] };
        let response = `# ${content.title || path}\n\n`;
        if (content.rawMarkdown) response += content.rawMarkdown + "\n\n";
        if (content.codeBlocks?.length > 0) {
          response += "## Code\n\n";
          content.codeBlocks.forEach(b => { response += `\`\`\`${b.language}\n${b.code}\n\`\`\`\n\n`; });
        }
        return { content: [{ type: "text", text: response }] };
      }
      
      const format = args.format || "markdown";
      const content = await client.getPageContent(path, format);
      if (!content) return { content: [{ type: "text", text: `Could not load: ${path}` }] };
      if (format === "markdown" && content.rawMarkdown) {
        let response = `# ${content.title || path}\n\n`;
        response += content.rawMarkdown + "\n\n";
        if (content.codeBlocks?.length > 0) {
          response += "## Code Examples\n\n";
          content.codeBlocks.forEach(b => { response += `\`\`\`${b.language}\n${b.code}\n\`\`\`\n\n`; });
        }
        return { content: [{ type: "text", text: response }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(content, null, 2) }] };
    }

    case "screenshot": {
      const client = await getStorybookBrowser();
      try {
        const screenshot = await client.takeScreenshot(args.path);
        return { content: [{ type: "image", data: screenshot.toString("base64"), mimeType: "image/png" }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Screenshot failed: ${error}` }] };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function main() {
  const server = new Server({ name: "storybook-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => handleToolCall(request.params.name, request.params.arguments || {}));

  process.on("SIGINT", async () => { if (storybookBrowser) await storybookBrowser.close(); process.exit(0); });
  process.on("SIGTERM", async () => { if (storybookBrowser) await storybookBrowser.close(); process.exit(0); });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(currentStorybookUrl ? `Storybook MCP (connected: ${currentStorybookUrl})` : "Storybook MCP (use the connect tool to set a URL)");
}

main().catch(error => { console.error("Fatal:", error); process.exit(1); });
