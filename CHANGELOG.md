# Changelog

All notable changes to this project. Versions before 2.0 were private builds.

## 2.0.0 (2026-10-22)

- English and Vietnamese UI. English is the default; `auto` follows the language of your latest prompt and remembers it
  for resumed sessions; `/fu lang en|vi|auto` pins or clears the choice. Tag labels: verify, next, handoff, needs input.
- The model rules no longer assume Vietnamese: suggestions follow the language of the latest request.
- Model text is untrusted: terminal escapes (CSI, OSC hyperlinks), control, bidi and invisible characters are stripped
  from new and restored rows.
- Risky rows are no longer dropped: a row naming a destructive, publishing or production action is shown with a ⚠
  mark, so a step you did ask for stays one click away. The check is wider (pipe-to-shell, `rm -fr`,
  `Remove-Item -Recurse`, `git clean -f`, force branch deletes, publishing, `gh pr merge`, `DELETE FROM`,
  `terraform destroy`, `kubectl delete`). Rows with a URL (`http://localhost:3000`) and side-effect skills
  (`/git-pushing`) are no longer filtered in code; the model rules decide when they fit.
- Discarding uncommitted work (`git checkout -- .`, `git restore <path>`, `git stash drop|clear`) is marked too, and
  `/fu log` shows the ⚠ mark on its rows.
- A ✓ mark goes away as soon as its text leaves the input box (cleared, or edited out), not only on the next `/fu` or
  a resume. A one-row menu no longer offers `/fu 1 3 · /fu all` in its footer.
- `/fu forget` deletes every stored session (menus, history, recent prompts); `/fu off` stops recording prompts.
- Older Claude Code: unreadable session surfaces count as unattended, and a missing `model.fork` API switches the mod
  off for the session with one notice instead of paying for a Haiku call every turn.
- POSIX paths under common roots (`/home/me/x`, `/Users`, `/tmp` ...), msys (`/c/Users/x`) and home (`~/x`) paths are
  recognised by the path checks and do not count toward the length limit; API routes (`/api/users/1`, `/v/1`,
  `/home/dashboard`) are not paths.
- The danger check does not mark prose "Delete from ..." or `git branch -d`; force branch deletes in any spelling
  (`-D`, `-d -f`, `-df`, `--delete --force`, `git -C repo branch -D`), upper-case `DELETE FROM` and SQL-like
  `delete from <table> where|;` are marked.
- Plugin manifest 2.0.0 with license, homepage and repository; a single-plugin marketplace manifest for
  `/plugin install`; MIT license; English README and this changelog.

## 1.9

- Menus survive exit + resume. A band of any age (up to 30 days) comes back after `claude --resume`; one older than
  30 minutes is labelled "from last time, N hours ago".
- Unattended sessions (`claude -p`, helper runs) no longer write to the store. They used to fill the 20-session index
  and push real sessions out within a few prompts.
- The index keeps up to 100 sessions that have something to restore, for 30 days, and prunes the rest.

## 1.8

- Coloured tag chips. `/fu rows 1-5|auto` sets the most rows a menu may have.

## 1.7

- Compact one-line header; keyboard hints moved to the footer.

## 1.6

- Skill and slash-command suggestions: the session's command list is read, the ~25 commands that match the request
  are described to the model, and any `/name` row the session does not have is dropped.

## 1.5

- Fixed whitespace normalisation in check marks and a race where a late menu appeared after the next prompt.

## 1.4

- A check mark means "this row is in the input box now"; marks are re-checked against the draft after a resume.

## 1.3

- Menus are no longer lost on Enter: replaced or sent menus go into a per-session history (`/fu log`).

## 1.2

- The insert-all button follows the state of the rows.

## 1.1

- Hiding folds the band into one line instead of discarding it (`/fu show` brings it back).

## 1.0

- The band survives a mod hot reload (state mirrored per session into the plugin store).

## 0.2 to 0.9

- First versions: suggestions from a cached fork of the session model with a Haiku fallback, the band above the
  input box, `/fu` commands, silence for self-contained answers, usage statistics and self-tuning, filters for
  destructive actions, missing paths, repeats of the answer, forbidden actions and off-topic rows.
