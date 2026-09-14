import { defineConfig } from "vitepress"

const base = `/${(process.env.DOCS_BASE ?? "").replace(/^\/+|\/+$/g, "")}/`.replace(/\/+/g, "/")
const repository = process.env.GITHUB_REPOSITORY
const repositoryUrl = repository ? `https://github.com/${repository}` : undefined
const sourceRef = encodeURIComponent(process.env.DOCS_SOURCE_REF ?? "main")

export default defineConfig({
  title: "Effect Domains",
  description: "Build SQLite-backed Effect applications with generated resource operations, CLI, MCP tools, and a browser admin.",
  lang: "en-US",
  base,
  cleanUrls: false,
  srcExclude: ["**/AGENTS.md"],
  head: [["meta", { name: "theme-color", content: "#6366f1" }]],
  themeConfig: {
    siteTitle: "Effect Domains",
    nav: [
      { text: "Get started", link: "/getting-started" },
      { text: "Guides", link: "/guides/define-a-resource", activeMatch: "/guides/" },
      { text: "Reference", link: "/reference/resources", activeMatch: "/reference/" },
      { text: "Examples", link: "/examples" },
    ],
    sidebar: [
      {
        text: "Start here",
        items: [
          { text: "Run your first application", link: "/getting-started" },
          { text: "How the pieces fit", link: "/concepts" },
          { text: "Choose an example", link: "/examples" },
        ],
      },
      {
        text: "Build an application",
        items: [
          { text: "Define a resource", link: "/guides/define-a-resource" },
          { text: "Restrict access", link: "/guides/authorization" },
          { text: "Change a stored schema", link: "/guides/migrations" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Resources and operations", link: "/reference/resources" },
          { text: "Runtime and clients", link: "/reference/runtime" },
          { text: "Durable execution", link: "/reference/runtime#durable-execution" },
        ],
      },
      {
        text: "Project research",
        collapsed: true,
        items: [
          { text: "Wiki overview", link: "/wiki/README" },
          { text: "Design thesis", link: "/wiki/thesis" },
          { text: "Detailed framework contract", link: "/wiki/tables-and-queries" },
          { text: "Research agenda", link: "/wiki/research-agenda" },
          { text: "Verification record", link: "/wiki/validation-strategy" },
        ],
      },
    ],
    search: {
      provider: "local",
      options: {
        _render(src, env, md) {
          // Public search serves current usage; research remains in the sidebar.
          return env.relativePath.startsWith("wiki/") ? "" : md.render(src, env)
        },
      },
    },
    outline: { level: [2, 3], label: "On this page" },
    socialLinks: repositoryUrl ? [{ icon: "github", link: repositoryUrl }] : [],
    editLink: repositoryUrl ? {
      pattern: `${repositoryUrl}/edit/${sourceRef}/docs/:path`,
      text: "Edit this page on GitHub",
    } : undefined,
    footer: { message: "Built with Effect. Documented with VitePress." },
  },
  transformPageData(page) {
    if (page.relativePath.startsWith("wiki/raw/")) {
      page.frontmatter.editLink = false
    }
  },
  markdown: {
    config(md) {
      // The wiki is plain Markdown, not Vue templates. Preserve literal
      // angle-bracket placeholders in immutable source quotations.
      md.core.ruler.before("normalize", "wiki-markdown", (state) => {
        // Inline fragments such as callout titles have no page environment.
        if (!state.env.relativePath) return
        state.md.options.html = !state.env.relativePath.startsWith("wiki/")
      })
      // Preserve repository-relative citations in Markdown; only the website
      // maps source files outside docs (and maintainer instructions) to GitHub.
      md.core.ruler.after("inline", "repository-links", (state) => {
        if (!state.env.relativePath) return
        for (const block of state.tokens) {
          let sourceLabel = false
          for (const token of block.children ?? []) {
            if (token.type === "link_close" && sourceLabel) {
              token.tag = "span"
              sourceLabel = false
            }
            if (token.type !== "link_open") continue
            const href = token.attrGet("href")
            if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue
            const target = new URL(href, `https://docs.invalid/docs/${state.env.relativePath}`)
            if (href.startsWith("/") || (target.pathname.startsWith("/docs/") && !target.pathname.endsWith("/AGENTS.md"))) {
              // VitePress prefixes numeric heading IDs; GitHub does not.
              token.attrSet("href", href.replace(/#(?=\d)/, "#_"))
              continue
            }
            if (repositoryUrl) {
              const view = target.pathname.endsWith("/") ? "tree" : "blob"
              token.attrSet("href", `${repositoryUrl}/${view}/${sourceRef}${target.pathname}${target.search}${target.hash}`)
            } else {
              // A checkout without a remote must not invent a repository URL.
              token.attrs = token.attrs?.filter(([name]) => name !== "href") ?? null
              token.attrSet("title", `${target.pathname.slice(1)} — set GITHUB_REPOSITORY=owner/repo to enable source links`)
              token.tag = "span"
              sourceLabel = true
            }
          }
        }
      })
    },
  },
})
