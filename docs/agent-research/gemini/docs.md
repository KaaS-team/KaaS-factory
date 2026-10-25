# Gemini CLI 0.61.0 (from the bundled docs and dist, no live run)
- Skills: workspace `.gemini/skills/` or `.agents/skills/` (alias wins). Context file: `GEMINI.md`.
- Headless: `gemini -o stream-json -p ""` with the prompt on stdin. Exit 0 ok, 1 error, 42 input error, 53 turn limit.
- Events (JSONL): init{session_id,model}; message{role,content,delta?}; tool_use{tool_name,tool_id,parameters};
  tool_result{tool_id,status,output,error?}; error; result{status:success|error,error?,stats{total_tokens,input_tokens,output_tokens,cached,input,duration_ms,tool_calls,models}}.
- Auth: GEMINI_API_KEY or GOOGLE_API_KEY.
