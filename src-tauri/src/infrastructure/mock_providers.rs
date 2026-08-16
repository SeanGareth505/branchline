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
            name: "Create feature branch".into(),
            description: "Create feature/{jira}/{date}, then open commit".into(),
            steps: vec![
                WorkflowStep::create_branch("feature/{jira}/{date}"),
                WorkflowStep::simple("openCommit"),
            ],
            builtin: true,
            enabled: true,
        },
        WorkflowInfo {
            id: "wf-switch".into(),
            name: "Switch branch".into(),
            description: "Choose a local branch and check it out".into(),
            steps: vec![WorkflowStep::simple("checkoutBranch")],
            builtin: true,
            enabled: true,
        },
        WorkflowInfo {
            id: "wf-switch-sync".into(),
            name: "Switch and sync".into(),
            description: "Check out a branch, then fetch and pull".into(),
            steps: vec![
                WorkflowStep::simple("checkoutBranch"),
                WorkflowStep::simple("fetch"),
                WorkflowStep::simple("pull"),
            ],
            builtin: true,
            enabled: true,
        },
        WorkflowInfo {
            id: "wf-sync".into(),
            name: "Sync with remote".into(),
            description: "Fetch, pull, then push your current branch".into(),
            steps: vec![
                WorkflowStep::simple("fetch"),
                WorkflowStep::simple("pull"),
                WorkflowStep::simple("push"),
            ],
            builtin: true,
            enabled: true,
        },
        WorkflowInfo {
            id: "wf-hotfix".into(),
            name: "Hotfix release".into(),
            description: "Create hotfix/{date}, commit, and push".into(),
            steps: vec![
                WorkflowStep::create_branch("hotfix/{date}"),
                WorkflowStep::simple("openCommit"),
                WorkflowStep::simple("push"),
            ],
            builtin: true,
            enabled: true,
        },
        WorkflowInfo {
            id: "wf-stash-pull".into(),
            name: "Stash and pull".into(),
            description: "Park local changes, pull, then refresh".into(),
            steps: vec![
                WorkflowStep::simple("stash"),
                WorkflowStep::simple("pull"),
                WorkflowStep::simple("refresh"),
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
            pattern: "## Summary\n\n## Test plan\n- [ ] ".into(),
            description: "PR description scaffold".into(),
        },
    ]
}
