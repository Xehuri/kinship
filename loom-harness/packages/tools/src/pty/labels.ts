/**
 * Model-facing PTY tool descriptions.
 *
 * Kept as inline strings (not .txt assets) because `tsc` does not copy asset
 * files into `dist/`, and the published subpath must resolve from compiled JS.
 */

export const PTY_SPAWN_DESCRIPTION = `Spawns a new interactive PTY (pseudo-terminal) session that runs in the background.

Unlike the built-in bash tool which runs commands synchronously and waits for completion, PTY sessions persist and allow you to:
- Run long-running processes (dev servers, watch modes, etc.)
- Send interactive input (including Ctrl+C, arrow keys, etc.)
- Read output at any time
- Manage multiple concurrent terminal sessions

Usage:
- \`command\` is required (e.g., "npm", "python", "bash")
- \`args\` passes arguments to the command (e.g., ["run", "dev"])
- \`workdir\` defaults to the workspace root. A relative path resolves against that root; an absolute path must stay inside the workspace. The PTY shell inherits a scrubbed environment, but an interactive \`cd\` afterwards can still leave the workspace (same escape surface as bash)
- \`env\` sets additional environment variables. Credential-looking keys (KEY/TOKEN/SECRET/PASSWORD/...) and LOOM_/AXEUH_/OPENCODE_/MI_/MOP_ prefixed keys are dropped
- \`title\` sets a human-readable session title
- \`description\` is required: a clear, concise 5-10 word description of what the session is for
- \`notifyOnExit\` defaults to TRUE in this harness: when the process exits you receive a \`<pty_exited>\` user message that wakes the session. Set it to false only if you plan to poll with \`pty_read\`
- \`timeoutSeconds\` auto-kills the PTY after a fixed number of seconds. Do not set it for sessions meant to keep running (dev servers, watch modes, local APIs, REPLs). Prefer it for long-running commands that should finish on their own (builds, test suites, e2e tests, migrations)

Returns the session info including:
- \`id\`: Unique identifier (pty_xxxxxxxx) for use with other pty_* tools
- \`pid\`: Process ID
- \`status\`: Current status ("running")

After spawning, use \`pty_write\` to send input, \`pty_read\` to read output, \`pty_list\` to list sessions and \`pty_kill\` to terminate the PTY.

Exit Notifications:
When \`notifyOnExit\` is true you receive a \`<pty_exited>\` message when the process exits (session ID and title, exit code, output line count, last line). The completion signal is that future message, not repeated \`pty_read\` calls.

Examples:
- Start a dev server: command="npm", args=["run", "dev"], title="Dev Server", notifyOnExit=true
- Start a Python REPL: command="python3", title="Python REPL"
- Run a build with a timeout: command="npm", args=["run", "build"], notifyOnExit=true, timeoutSeconds=900`;

export const PTY_WRITE_DESCRIPTION = `Sends input data to an active PTY session.

Use this tool to:
- Type commands or text into an interactive terminal
- Send special key sequences (Ctrl+C, Enter, arrow keys, etc.)
- Respond to prompts in interactive programs

Usage:
- \`id\`: The PTY session ID (from pty_spawn or pty_list)
- \`data\`: The input to send (text, commands, or escape sequences)

Escape sequences in \`data\` are parsed before sending:
- Enter/newline: "\\n" or "\\r"
- Tab: "\\t"
- Backslash: "\\\\"
- Hex byte: "\\xNN" (two hex digits)
- Unicode code point: "\\uNNNN" (four hex digits)
- Ctrl+C (interrupt): "\\x03"
- Ctrl+D (EOF): "\\x04"
- Ctrl+Z (suspend): "\\x1a"
- Arrow Up: "\\x1b[A"
- Arrow Down: "\\x1b[B"
- Arrow Right: "\\x1b[C"
- Arrow Left: "\\x1b[D"

Returns a confirmation with the number of bytes sent and a preview of the parsed input.

Examples:
- Send a command: data="ls -la\\n"
- Interrupt a process: data="\\x03"
- Answer a prompt: data="yes\\n"`;

export const PTY_READ_DESCRIPTION = `Reads output from a PTY session's buffer.

The PTY maintains a rolling character buffer (default 1,000,000 chars; oldest output is discarded when the limit is reached). Use offset and limit to paginate through complete output lines, similar to reading a file.

Usage:
- \`id\`: The PTY session ID (from pty_spawn or pty_list)
- \`offset\`: Line number to start reading from (0-based, defaults to 0)
- \`limit\`: Number of lines to read (defaults to 500)
- \`pattern\`: Regex pattern to filter lines (optional). Must be at most 500 characters and must not contain dangerous nested quantifiers such as (.*)* or repeated alternation
- \`ignoreCase\`: Case-insensitive pattern matching (default: false)

Returns:
- Numbered lines of output (cat -n format)
- Total line count in the buffer
- An indicator when more lines are available

Pattern Filtering:
- When \`pattern\` is set, lines are FILTERED FIRST using the regex, then offset/limit apply to the MATCHES
- Original line numbers are preserved so you can see where matches occurred in the buffer
- Supports full regex syntax (e.g., "error", "ERROR|WARN", "failed.*connection")
- Invalid or unsafe patterns throw an error
- If no lines match, a clear message indicates zero matches

Tips:
- To see the latest output, use a high offset
- To tail recent output, calculate offset as (totalLines - N) where N is how many recent lines you want
- Lines longer than 2000 characters are truncated
- Empty output may mean the process has not produced output yet
- If the session was started with \`notifyOnExit=true\`, do not poll with \`pty_read\` to detect completion; wait for the future \`<pty_exited>\` message instead

Examples:
- Read first 100 lines: offset=0, limit=100
- Read lines 500-600: offset=500, limit=100
- Find errors: pattern="error", ignoreCase=true
- Find specific log levels: pattern="ERROR|WARN|FATAL"
- First 10 matches only: pattern="error", limit=10`;

export const PTY_LIST_DESCRIPTION = `Lists all PTY sessions owned by the current session (active and exited).

Use this tool to:
- See all running and exited PTY sessions
- Get session IDs for use with other pty_* tools
- Check the status and output line count of each session
- Monitor which processes are still running

Returns for each session:
- \`id\`: Unique identifier for use with other tools
- \`title\`: Human-readable name
- \`command\`: The command that was executed
- \`status\`: Current status (running, killing, exited, killed)
- \`exitCode\`: Exit code (if exited/killed)
- \`pid\`: Process ID
- \`lineCount\`: Number of lines in the output buffer
- \`createdAt\`: When the session was created

Tips:
- Use the session ID with pty_read, pty_write, or pty_kill
- Sessions remain in the list after exit until explicitly cleaned up with pty_kill
- This allows you to compare output from multiple sessions`;

export const PTY_KILL_DESCRIPTION = `Terminates a PTY session and optionally cleans up its buffer.

Use this tool to:
- Stop a running process (sends SIGTERM)
- Clean up an exited session to free memory
- Remove a session from the list

Usage:
- \`id\`: The PTY session ID (from pty_spawn or pty_list)
- \`cleanup\`: If true, removes the session and frees the buffer (default: false)

Behavior:
- If the session is running, it will be killed (status becomes "killed")
- If cleanup=false (default), the session remains in the list with its output buffer intact
- If cleanup=true, the session is removed entirely and the buffer is freed
- Keeping sessions without cleanup allows you to compare logs between runs

Tips:
- Use cleanup=false if you might want to read the output later
- Use cleanup=true when you are done with the session entirely
- To send Ctrl+C instead of killing, use pty_write with data="\\x03"

Examples:
- Kill but keep logs: cleanup=false (or omit)
- Kill and remove: cleanup=true`;
