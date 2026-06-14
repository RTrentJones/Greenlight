output "develop_branch" {
  value       = github_branch.develop.branch
  description = "The created beta branch name."
}

output "protected_patterns" {
  value = [github_branch_protection.main.pattern, github_branch_protection.develop.pattern]
}
