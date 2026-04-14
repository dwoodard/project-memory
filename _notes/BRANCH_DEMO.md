# Demonstrate Branch-Aware Tasks

Please walk through the branch-aware task management system in pensieve. Follow these steps exactly in order:

1. Create a task: `pensieve tasks add "Build user authentication"`
2. Start it: `pensieve tasks start 1` — watch for the auto-generated branch slug
3. Create feature branch: `git checkout -b` with the branch name from step 2
4. View tasks: `pensieve tasks` — notice the branch is now displayed
5. Add three subtasks (they auto-parent):
   - `pensieve tasks add "Write login form component"`
   - `pensieve tasks add "Set up authentication API endpoint"`
   - `pensieve tasks add "Add unit tests"`
6. View task tree: `pensieve tasks` — see the checklist
7. See branch context: `pensieve context` | head -30 — notice "Branch Orientation" header
8. Check branch: `pensieve tasks branch db43de` or use the shortId from your task
9. Add PR: `pensieve tasks pr db43de "https://github.com/yourrepo/pull/123"`
10. View in-review: `pensieve tasks` — see "AWAITING REVIEW" section with PR #123
11. Complete work: `pensieve tasks done db43de --note "Merged PR with full auth flow"`
12. See cascade: `pensieve tasks --done` — notice all 3 subtasks also marked done
13. Back to master: `git checkout master` then `pensieve tasks --done` — branch info still shown

After completing the walkthrough:
- Report what features worked
- Note any issues or unexpected behavior

