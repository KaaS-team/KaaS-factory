# LWP Shared House Rules

These rules are non-negotiable and override anything else in any skill file. Every content artifact (blog post, course, landing page, presentation, carousel) must comply.

Feedback memory files (`feedback_*.md` in the project memory directory) override these rules. If a feedback file conflicts with anything below, the feedback memory wins.

---

## Rule 1: No counts in marketing or narrative copy

Never write "16 modules", "13 weeks", "43 tutorials", "2 days", "5 minutes", "3 things to remember", "two big wins", "5 reasons", "7 mistakes" in hero headlines, pain cards, reframe bullets, slide titles, body text, CTA sections, FAQ answers, or any narrative copy. Sell the transformation, not the inventory.

**Counts are OK only in:**
- Metadata fields (`estimatedHours`, `estimatedWeeks`, `totalXp`, `order`, pricing in cents)
- Curriculum sections that show actual titles next to the count
- Code blocks (timeouts, sizes, ports, HTTP status codes, config values)
- Data visualization components (`<BigNumber>`, `<StatRow>`, `<BarChart>`, `<MetricCard>`) where the count carries real data
- Structured lists where the count refers to real enumerated items that appear on the same page/slide
- Real citations with a source ("Our benchmark showed 40% faster inference on a 7B model")
- Infographic templates where the count matches the actual number of items rendered

See `feedback_no_spelled_numbers.md`.

## Rule 2: No positional references

Never write "Module 5", "next module", "previous module", "Lesson 3 of 7", "Part 2 of 4", "in chapter 4", "slide 4 of 12", "next section", "previous slide", "as mentioned in chapter 2", "page 1 of 4". Reference the concept or phase instead: "Auth done", "next up: caching", "the foundations phase", "earlier you built the validating CLI". Content must survive reorders and republication. Achievement IDs and internal slugs are the only places positional words are allowed.

See `feedback_no_positional_references.md`.

## Rule 3: No emdashes

Never use em dashes (—), en dashes (–), or double hyphens (--) in any text content. Restructure into natural English. Never do mechanical find-and-replace.

**Reach for a colon first** when the dash joined a claim to its example or its reason: "A step is small enough when you can check it alone: one expected result, one command." A colon keeps the two halves as separate short sentences. Without it the rewrite drifts into one long sentence held together by conjunctions, which breaks Rule 11. Then a new sentence, then a comma or parentheses.

See `feedback_no_emdashes.md` and `feedback_emdash_replacement.md`.

## Rule 4: No bold markdown in rendered content

Never use `**bold**` markdown in content strings that flow into JSX props, component props, scene text, or anything that renders raw (displays as literal asterisks). Regular markdown `**bold**` in the body of a normal blog post is fine.

## Rule 5: No AI slop

Never use these words or phrases in any content:

**Banned words**: delve, leverage, seamless, paradigm, robust, landscape, realm, crucial, cutting-edge, game-changer, unleash, revolutionize, straightforward, notably

**Banned phrases**: "as an AI", "let's dive in", "in today's world", "buckle up", "here's the thing", "the reality is", "it's worth noting", "it's important to note", "it should be noted", "at its core", "in the ever-evolving", "without further ado", "in this comprehensive guide", "a testament to", "navigate the complexities", "stands out as", "serves as a", "whether you're a beginner or an experienced", "in today's rapidly evolving", "in today's fast-paced"

## Rule 6: No generic claims

Never use "best", "top", "amazing", "revolutionary" as standalone claims. Use specific, defensible claims with a number, a mechanism, or a name. This rule applies primarily to landing pages and marketing copy but good practice everywhere.

## Rule 7: Sentence case for all headings and titles, capitalize after colon

All headings (H1, H2, H3), slide titles, card titles, frontmatter `title`/`seoTitle`, meta titles, hero headlines, section headings, pain card titles, step titles, lesson/module titles, and any rendered heading use sentence case. Only the first word and proper nouns are capitalized. Not title case.

**Colon exception:** When a title contains a colon, capitalize the first letter immediately after the colon as if it begins a new clause. Acronyms, proper nouns, and intentionally lowercase tool names keep their casing (e.g., `pip`, `uv`, `npm`).

GOOD: "Why is pip painful for production AI service dependencies?"
BAD:  "Why Is pip Painful for Production AI Service Dependencies?"

GOOD: "Build a coding agent with Claude"
BAD:  "Build A Coding Agent With Claude"

GOOD: "Stop guessing. Ship grounded answers."
BAD:  "Stop Guessing. Ship Grounded Answers."

GOOD: "RAG fundamentals: From embeddings to agentic retrieval"
BAD:  "RAG fundamentals: from embeddings to agentic retrieval"

GOOD: "Docker for FastAPI: Multi-stage builds and a compose stack that mirrors production"
BAD:  "Docker for FastAPI: multi-stage builds and a compose stack that mirrors production"

GOOD: "Async Python patterns: Make slow FastAPI services fast"
BAD:  "Async Python patterns: make slow FastAPI services fast"

### Capitalization allowlist

Preserve capitalization for:

- **Proper nouns and brands**: Python, Docker, Claude, Anthropic, OpenAI, GPT, Haiku, Sonnet, Opus, FastAPI, LangGraph, LangChain, Postgres, Redis, Kubernetes, Uvicorn, Pydantic, SQLAlchemy, SQLModel, PgBouncer, Neo4j, Qdrant, Langfuse, Tenacity, Grafana, Prometheus, Ragas.
- **Acronyms**: RAG, LLM, API, HTTP(S), JSON, YAML, SQL, CLI, CI, CD, IDE, SDK, UI, UX, ASGI, WSGI, SSE, JWT, CORS, DNS, TCP, TLS, OS, CPU, GPU, MCP, OWASP, AEO, GEO, SEO, MTEB, BGE, E5, RRF.
- **Intentionally lowercase tool names**: pip, uv, npm, pnpm, ripgrep, rg, pytest, asyncio, httpx, asyncpg, jsonb, bash, grep, cat, ls.

## Rule 8: Links must resolve and cite primary sources

### Internal links
- 2-5 internal links per blog post or landing page. Use relative paths only (`/blog/<slug>`, never absolute URLs).
- Every internal link MUST resolve to a real route. Broken internal links fail the rubric with zero partial credit.
- Prefer linking within the same topic cluster. Descriptive anchor text (2-5 words). Never "click here", "this post", "here", "link".

### External citations
- HTTPS only. 1-3 per post, 5 is the ceiling.
- Prefer primary sources: official docs, research papers (arxiv), standards bodies, official repos/engineering blogs.
- Avoid: content-farm aggregators, paywalled pages when free primary source exists, ephemeral URLs, short-link redirectors.
- Every external link MUST return HTTP 200 on a HEAD check. Broken externals fail the rubric with zero partial credit.
- Anchor text is the name of the source, never "here" or "link".

### Link health verification
- `scripts/link_health.py` checks all links. Internal links resolve against the Next.js route registry. External links use cached HTTP HEAD (10s timeout, 3 retries, 7-day TTL).
- A post/page with any broken link cannot score >= 95.

## Rule 9: Clarity beats cleverness in headlines and hooks

Every headline, hero, hook, slide title, and opening line must be understood on first read, with no decoding. A reader should know what it is about and why it matters in about five seconds.

- State the problem or outcome in plain words. No puns, metaphors, riddles, or in-group jargon in a headline or H1.
- Keep personality and voice in the supporting line (subhead, body, dek), not in the headline itself.
- Headlines stay short and concrete. One idea. If a reader has to pause to work out what it means, rewrite it plainer.
- Cut value-free taglines and mood-only kickers; a kicker must add information.

This is strongest on landing/marketing pages but applies to every artifact. See `lwp-landing` "Hero clarity gate" for the scored version.

## Rule 10: Simple English in body copy

Write so a busy engineer gets it on first read. Short sentences. Active voice. Everyday words. Read like a staff engineer explaining over coffee, not a whitepaper.

- Prefer plain, often 1-syllable words. Cut qualifiers ("basically", "essentially", "really") and hedges ("might", "could potentially").
- No idioms or invented figures of speech a non-native reader would have to decode ("leaving X on the table", "cast a wide net", "earns its cost", "moves the needle", "bang for the buck", "the naive road is gone", "pin it"). State the literal point.
- Structural terms are not metaphors, they are the vocabulary: layer, boundary, checkpoint, loop, pipeline, gate, stack, prefix, window, queue. Use them. Invent nothing beyond them.
- One clause per idea. Split long multi-clause sentences.
- Technical terms an engineer already knows are fine (RAG, BM25, latency). Explain or drop terms that only insiders decode.

**Banned idioms**: in flight, tails its, tail the transcript, bitten, melt a laptop, parks for, on the table, cast a wide net, moves the needle, bang for the buck, earns its cost

These are the ones that reached a deck once. `house_rules.py --voice` fails each, and the rest of this rule is still read by the author.

Rule 9 governs headlines and hooks; this extends the same clarity to body copy: subheads, subs, tags, callouts, panels, table cells, and captions. Rule 5 bans AI-slop words; Rule 10 also bans idioms and needless complexity even when the words are not on the slop list.

## Rule 11: One idea per sentence

Each sentence makes one point, subject first, in the active voice. When a sentence chains three clauses with commas, split it into three sentences. Sentences that stack clauses are what made vault prose unreadable; a reader should never have to hold the start of a sentence in mind to reach its end.

**Words per sentence**: 28
**Sentences per paragraph**: 4

- The ceilings are ceilings, not targets. Most sentences run 12 to 16 words. Do not pad short ones and do not chop a clear long one into fragments.
- Name the action, not the concept: "verify the result", not "perform verification of the result". This half is model-judged, see `voice.md`.
- A one-line fragment may follow a complete explanation, as a beat: "That is the whole trick." It never replaces the explanation. This supersedes the blanket fragment ban in `feedback_teaching_voice.md` where the two differ.
- Voice guidance with good and bad pairs lives in `voice.md`. Read it before writing.

## Rule 12: Name a thing by its standard term, never a paraphrase

Every box, label, title and caption uses the name the thing already has: the name in the code, then the name on deck 1, then the name in the docs. A paraphrase in plain words is not simpler, it is a second name, and the room cannot connect it to the terminal, the code or the next hour. Rule 10 asks for plain English. It does not license renaming a term an engineer already knows.

Resolve a name in this order, and stop at the first hit:

1. **The code.** A box for `guardrails_agent` reads "Guardrails agent". `error_agent` is "Error agent", `sql_agent` is "SQL agent", `execute_sql` is "Execute SQL", `viz_agent` is "Viz agent".
2. **Deck 1** (`software-factory`). The six layers, in build order, are Boundary, Execution, Context, Skills, Verification, Delivery, never "What it may touch", "What it knows" or "How we work". Those are its captions, which sit beside the names and never replace them.
3. **The workbook concept index** (`lwp-repos/software-factory/factory/workbook.html`): worktree, branch claim, sandbox limits, protected path, negative proof, holdout tests, gate verdict, triage, draft PR, human merge gate.
4. **Industry vocabulary** an engineer already uses: sandbox, guardrails, worktree, triage, holdout, idempotent. Never invent a friendlier word.

- BAD: "Own folder", "Its limits", "Claim fq-2" (the box is a worktree, the limits are sandbox limits, the claim is a branch claim).
- BAD: "A guard", "Repair from the error", "An answer" (Guardrails agent, Error agent, Analysis agent).
- BAD: "hidden checks", "sorted first" (holdout tests, triage).
- GOOD: "Worktree", "Sandbox limits", "Branch claim", "Guardrails agent", "Error agent", "Holdout tests", "Triage".

A term that mirrors the screen stays as the screen prints it. The lab prints "A workspace for ..." so a caption that quotes that line keeps "workspace".

The lines below are the machine-checked half: each names the standard term and the paraphrases that are banned in a deck's slides, notes and drawings. `house_rules.py --terms` reads them, `check:house` in `lwp-deck` runs it, and a phrase added here is armed in the same edit. Add a row the first time a paraphrase gets past review.

- **worktree**: not "own folder", "its own folder", "folder of its own", "folder per task", "folder each", "a folder for every task", "makes a workspace", "no workspace"
- **worktree or checkout**: not "the folder", "a folder", "same folder", "new folder", "folder is gone"
- **holdout tests**: not "hidden checks", "hidden check", "hidden suite", "hidden tests", "hidden test", "checks the writer never saw", "checks it never saw"
- **guardrails agent**: not "a guard", "the guard", "guard call"
- **error agent**: not "repair step"
- **cold reader**: not "cold verifier", "cold reviewer"
- **triage**: not "sorted first", "sorting before", "is sorted before", "are sorted before", "sort every issue", "sort each issue", "sorting every item", "sorted every issue"
- **claim**: not "owns the item", "first run own the item"
- **agent run ledger**: not "ledger repository", "the ledger repo", "ledger app"
- **subscription app**: not "subscription service" (`ai-sre-workshop`'s Flask signup app)
- **agent loop**: not "runtime loop"
- **finish_reason**: not "cut-off check", "cutoff check"
- **durable ledger**: not "ledger on disk"
- **context assembler**: not "code builds the context"
- **persistent facts**: not "rules survive summary", "rules survive the summary"
- **path-scoped rules**: not "rules chosen by path"
- **direct prompt injection**: not "order in the resume"
- **delimiter**: not "text gets sealed"
- **instruction isolation**: not "typed tag stripped"
- **context pruning**: not "prune safely"
- **validator**: not "text check"
- **human in the loop**: not "person in the loop", "people in the loop", "persons in the loop"
- **human review**: not "person layer", "keep a person on", "then a person", "two people approve", "one person to approve", "what stays with a person"
- **step**: not "every station", "each station", "these stations", "six stations", "slowest station", "one context layer sits under", "drain the loops", "drained through", "where the crossover sits"
- **review queue**: not "sent to review"
- **forced tool_choice**: not "forced tool call"
- **syntactic validity**: not "valid shape"
- **MCP server**: not "server: child process"

The set is a floor. The rest of this rule is model-judged: resolve the name in the order above before you draw a box.

---

## Enforcement

These rules are checked by each skill's scoring rubric. Violating any rule costs points. Feedback memory files are the override layer and always win over these base rules.
