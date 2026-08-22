use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MockPullRequest {
    pub id: String,
    pub number: u32,
    pub title: String,
    pub author: String,
    pub assignees: Vec<String>,
    pub reviewers: Vec<String>,
    pub team: String,
    pub repo: String,
    pub source_branch: String,
    pub target_branch: String,
    pub status: String,
    pub url: String,
    pub labels: Vec<String>,
    pub updated_at: String,
    pub draft: bool,
    pub review_state: String,
    pub pipeline_status: String,
    pub additions: u32,
    pub deletions: u32,
    pub comment_count: u32,
    pub is_mine: bool,
    pub needs_my_review: bool,
    #[serde(default)]
    pub approvals: u32,
    #[serde(default)]
    pub changes_requested: u32,
    #[serde(default)]
    pub pending_reviewers: u32,
    #[serde(default)]
    pub approved_by: Vec<String>,
    #[serde(default)]
    pub requested_changes_by: Vec<String>,
    #[serde(default)]
    pub commented_by: Vec<String>,
    #[serde(default)]
    pub check_passed: u32,
    #[serde(default)]
    pub check_failed: u32,
    #[serde(default)]
    pub check_pending: u32,
    #[serde(default)]
    pub check_total: u32,
    #[serde(default)]
    pub mergeable: Option<bool>,
    #[serde(default)]
    pub merge_state: String,
    #[serde(default)]
    pub ready_to_merge: bool,
    #[serde(default)]
    pub check_summary: String,
    #[serde(default)]
    pub check_failed_names: Vec<String>,
    #[serde(default)]
    pub check_pending_names: Vec<String>,
    #[serde(default)]
    pub body: String,
}

impl Default for MockPullRequest {
    fn default() -> Self {
        Self {
            id: String::new(),
            number: 0,
            title: String::new(),
            author: String::new(),
            assignees: Vec::new(),
            reviewers: Vec::new(),
            team: String::new(),
            repo: String::new(),
            source_branch: String::new(),
            target_branch: String::new(),
            status: String::new(),
            url: String::new(),
            labels: Vec::new(),
            updated_at: String::new(),
            draft: false,
            review_state: "unknown".into(),
            pipeline_status: "unknown".into(),
            additions: 0,
            deletions: 0,
            comment_count: 0,
            is_mine: false,
            needs_my_review: false,
            approvals: 0,
            changes_requested: 0,
            pending_reviewers: 0,
            approved_by: Vec::new(),
            requested_changes_by: Vec::new(),
            commented_by: Vec::new(),
            check_passed: 0,
            check_failed: 0,
            check_pending: 0,
            check_total: 0,
            mergeable: None,
            merge_state: String::new(),
            ready_to_merge: false,
            check_summary: String::new(),
            check_failed_names: Vec::new(),
            check_pending_names: Vec::new(),
            body: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStepConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_point: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkout: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stash_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_prompt: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum WorkflowStep {
    Simple(String),
    Detailed {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        config: Option<WorkflowStepConfig>,
    },
}

impl WorkflowStep {
    pub fn simple(id: impl Into<String>) -> Self {
        Self::Simple(id.into())
    }

    pub fn create_branch(pattern: impl Into<String>) -> Self {
        Self::Detailed {
            id: "createBranch".into(),
            config: Some(WorkflowStepConfig {
                name_pattern: Some(pattern.into()),
                checkout: Some(true),
                ..Default::default()
            }),
        }
    }

    pub fn stash_auto() -> Self {
        Self::Detailed {
            id: "stash".into(),
            config: Some(WorkflowStepConfig {
                skip_prompt: Some(true),
                ..Default::default()
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub steps: Vec<WorkflowStep>,
    pub builtin: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub pattern: String,
    pub description: String,
}

pub fn builtin_workflows() -> Vec<WorkflowInfo> {
    vec![
        WorkflowInfo {
            id: "wf-feature".into(),
            name: "Start feature".into(),
            description: "Create feature/{jira}/{date} and check it out".into(),
            steps: vec![WorkflowStep::create_branch("feature/{jira}/{date}")],
            builtin: true,
            enabled: true,
        },
        WorkflowInfo {
            id: "wf-hotfix".into(),
            name: "Start hotfix".into(),
            description: "Create hotfix/{date} from the current HEAD".into(),
            steps: vec![WorkflowStep::create_branch("hotfix/{date}")],
            builtin: true,
            enabled: true,
        },
        WorkflowInfo {
            id: "wf-switch-sync".into(),
            name: "Switch and update".into(),
            description: "Check out a branch, then rebase onto upstream".into(),
            steps: vec![
                WorkflowStep::simple("checkoutBranch"),
                WorkflowStep::simple("pullRebase"),
            ],
            builtin: true,
            enabled: true,
        },
        WorkflowInfo {
            id: "wf-sync".into(),
            name: "Update from remote".into(),
            description: "Rebase the current branch onto upstream".into(),
            steps: vec![WorkflowStep::simple("pullRebase")],
            builtin: true,
            enabled: true,
        },
        WorkflowInfo {
            id: "wf-commit-push".into(),
            name: "Commit and push".into(),
            description: "Commit current changes, then push".into(),
            steps: vec![
                WorkflowStep::simple("openCommit"),
                WorkflowStep::simple("push"),
            ],
            builtin: true,
            enabled: true,
        },
        WorkflowInfo {
            id: "wf-stash-pull".into(),
            name: "Stash and update".into(),
            description: "Park local changes, then rebase onto upstream".into(),
            steps: vec![
                WorkflowStep::stash_auto(),
                WorkflowStep::simple("pullRebase"),
            ],
            builtin: true,
            enabled: true,
        },
    ]
}

pub fn list_templates() -> Vec<TemplateInfo> {
    vec![
        TemplateInfo {
            id: "tpl-feat".into(),
            name: "Feature".into(),
            kind: "commit".into(),
            pattern: "feat: {summary}\n\n{details}".into(),
            description: "Conventional feature commit".into(),
        },
        TemplateInfo {
            id: "tpl-fix".into(),
            name: "Fix".into(),
            kind: "commit".into(),
            pattern: "fix: {summary}\n\nFixes {jira}".into(),
            description: "Bug fix commit".into(),
        },
        TemplateInfo {
            id: "tpl-branch".into(),
            name: "Feature branch".into(),
            kind: "branch".into(),
            pattern: "feature/{jira}/{date}".into(),
            description: "Standard feature branch name".into(),
        },
        TemplateInfo {
            id: "tpl-pr".into(),
            name: "Pull request".into(),
            kind: "pullRequest".into(),
            pattern: "## Description\n\n{topic}\n\n## Jira Ticket\n\n{jira_link}\n\n## Changes\n\n{commits}\n\n## Screenshots\n\n## Test plan\n\n- [ ] ".into(),
            description: "PR description scaffold".into(),
        },
    ]
}
