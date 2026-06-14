variable "repository" {
  type        = string
  description = "Repository name (just the repo, e.g. my-site — owner comes from the github provider)."
}

variable "default_branch" {
  type        = string
  default     = "main"
  description = "Prod branch."
}

variable "develop_branch" {
  type        = string
  default     = "develop"
  description = "Beta branch (created from default_branch)."
}

variable "required_checks" {
  type        = list(string)
  default     = []
  description = "Status check contexts required before merge (e.g. the CI job name)."
}
