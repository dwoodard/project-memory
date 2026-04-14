# Branch-Aware Tasks Feature Walkthrough

This is a guided workflow to demonstrate and test the branch-aware task management system in pensieve.

## Full Workflow (~30 seconds)

```bash
# 1. Create a new test task
pensieve tasks add "Build user authentication"

# 2. Start the task (generates branch slug automatically)
pensieve tasks start 1

# 3. Create and checkout the feature branch with that name
# (Copy the "Branch: xxx" output from step 2)
git checkout -b db43de-build-user-authentication

# 4. View tasks - see branch info displayed
pensieve tasks

# 5. Add subtasks on the feature branch (auto-parents to parent task)
pensieve tasks add "Write login form component"
pensieve tasks add "Set up authentication API endpoint"
pensieve tasks add "Add unit tests"

# 6. View tasks again - see subtask checklist
pensieve tasks

# 7. See branch context in session bundle
pensieve context

# 8. Check the branch name for this task
pensieve tasks branch db43de

# 9. Simulate creating a PR (records URL, marks task as in-review)
pensieve tasks pr db43de "https://github.com/yourrepo/pull/123"

# 10. View tasks - task now in "AWAITING REVIEW" section
pensieve tasks

# 11. Mark parent task done (cascades to children)
pensieve tasks done db43de --note "Merged PR with full auth flow"

# 12. View done tasks - see parent with 3 subtasks, all marked complete
pensieve tasks --done

# 13. Switch back to master - branch info still visible
git checkout master
pensieve tasks --done
```

## What to Notice

- **Step 2**: Branch slug appears automatically (format: `{shortId}-{title}`)
- **Step 5**: New tasks auto-parent without explicit `--parent` flag
- **Step 7**: Branch orientation header shows current branch + matching task
- **Step 9**: Task moves to "AWAITING REVIEW" with PR URL and number extracted
- **Step 11**: All child tasks cascade to done automatically
- **Step 13**: Branch info visible even from master branch

## Key Features Demonstrated

✅ **Branch Slug Generation** - Parent tasks get auto-generated branch names  
✅ **Auto-Parent Detection** - Subtasks automatically link on feature branches  
✅ **Task Display** - Branch info shown in task lists  
✅ **Session Context** - Branch orientation in `pensieve context`  
✅ **PR Tracking** - `tasks pr` records URLs and shows in-review status  
✅ **Cascade Logic** - Marking parent done cascades to children  
✅ **Backward Compatible** - Branch info visible from any branch

## Quick Version (10 seconds)

If you just want to see the core features:

```bash
pensieve tasks add "Test feature"
pensieve tasks start 1
git checkout -b $(pensieve tasks | grep "Branch:" | awk '{print $NF}')
pensieve tasks add "Subtask 1"
pensieve tasks add "Subtask 2"
pensieve tasks
pensieve context | head -20
pensieve tasks done 1 --note "Done"
```
