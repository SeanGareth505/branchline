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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MockJiraIssue {
    pub key: String,
    pub summary: String,
    pub status: String,
    pub assignee: String,
    pub priority: String,
    pub issue_type: String,
    pub url: String,
    pub updated_at: String,
    pub labels: Vec<String>,
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

pub fn list_mock_pull_requests() -> Vec<MockPullRequest> {
    vec![
        MockPullRequest {
            id: "pr-101".into(),
            number: 101,
            title: "Improve commit graph focus mode".into(),
            author: "alex".into(),
            assignees: vec!["alex".into()],
            reviewers: vec!["jamie".into(), "sam".into()],
            team: "Platform".into(),
            repo: "branchline".into(),
            source_branch: "feature/graph-focus".into(),
            target_branch: "main".into(),
            status: "open".into(),
            url: "https://github.com/example/branchline/pull/101".into(),
            labels: vec!["ui".into(), "graph".into()],
            updated_at: "2026-07-17T14:22:00Z".into(),
            draft: false,
            review_state: "approved".into(),
            pipeline_status: "success".into(),
            additions: 420,
            deletions: 88,
            comment_count: 6,
            is_mine: false,
        },
        MockPullRequest {
            id: "pr-98".into(),
            number: 98,
            title: "Add safety preflight for force-with-lease".into(),
            author: "jamie".into(),
            assignees: vec!["jamie".into()],
            reviewers: vec!["alex".into()],
            team: "Platform".into(),
            repo: "branchline".into(),
            source_branch: "feature/safety-dialogs".into(),
            target_branch: "main".into(),
            status: "open".into(),
            url: "https://github.com/example/branchline/pull/98".into(),
            labels: vec!["safety".into()],
            updated_at: "2026-07-16T09:10:00Z".into(),
            draft: true,
            review_state: "pending".into(),
            pipeline_status: "pending".into(),
            additions: 210,
            deletions: 40,
            comment_count: 2,
            is_mine: false,
        },
        MockPullRequest {
            id: "pr-95".into(),
            number: 95,
            title: "Commit dialog with templates and amend".into(),
            author: "you".into(),
            assignees: vec!["you".into()],
            reviewers: vec!["alex".into(), "jordan".into()],
            team: "Product".into(),
            repo: "branchline".into(),
            source_branch: "feature/commit-modal".into(),
            target_branch: "main".into(),
            status: "open".into(),
            url: "https://github.com/example/branchline/pull/95".into(),
            labels: vec!["ux".into(), "commit".into()],
            updated_at: "2026-07-18T11:00:00Z".into(),
            draft: false,
            review_state: "changesRequested".into(),
            pipeline_status: "failure".into(),
            additions: 640,
            deletions: 120,
            comment_count: 11,
            is_mine: true,
        },
        MockPullRequest {
            id: "pr-92".into(),
            number: 92,
            title: "Dashboard fuzzy search for recent repos".into(),
            author: "sam".into(),
            assignees: vec!["sam".into()],
            reviewers: vec!["you".into()],
            team: "Product".into(),
            repo: "branchline".into(),
            source_branch: "feature/dashboard-search".into(),
            target_branch: "develop".into(),
            status: "merged".into(),
            url: "https://github.com/example/branchline/pull/92".into(),
            labels: vec!["dashboard".into()],
            updated_at: "2026-07-12T18:40:00Z".into(),
            draft: false,
            review_state: "approved".into(),
            pipeline_status: "success".into(),
            additions: 180,
            deletions: 22,
            comment_count: 4,
            is_mine: false,
        },
        MockPullRequest {
            id: "pr-88".into(),
            number: 88,
            title: "Azure DevOps PR adapter scaffold".into(),
            author: "jordan".into(),
            assignees: vec!["jordan".into(), "alex".into()],
            reviewers: vec!["jamie".into()],
            team: "Integrations".into(),
            repo: "branchline".into(),
            source_branch: "feature/ado-prs".into(),
            target_branch: "main".into(),
            status: "open".into(),
            url: "https://github.com/example/branchline/pull/88".into(),
            labels: vec!["integration".into(), "ado".into()],
            updated_at: "2026-07-15T07:30:00Z".into(),
            draft: false,
            review_state: "pending".into(),
            pipeline_status: "success".into(),
            additions: 510,
            deletions: 30,
            comment_count: 3,
            is_mine: false,
        },
        MockPullRequest {
            id: "pr-81".into(),
            number: 81,
            title: "Fix SSL path for corporate proxies".into(),
            author: "you".into(),
            assignees: vec!["you".into()],
            reviewers: vec!["sam".into()],
            team: "Platform".into(),
            repo: "branchline".into(),
            source_branch: "bug/ssl-proxy".into(),
            target_branch: "release/1.0".into(),
            status: "closed".into(),
            url: "https://github.com/example/branchline/pull/81".into(),
            labels: vec!["bug".into()],
            updated_at: "2026-07-08T20:15:00Z".into(),
            draft: false,
            review_state: "approved".into(),
            pipeline_status: "cancelled".into(),
            additions: 45,
            deletions: 12,
            comment_count: 1,
            is_mine: true,
        },
        MockPullRequest {
            id: "pr-77".into(),
            number: 77,
            title: "Jira branch-from-issue workflow".into(),
            author: "alex".into(),
            assignees: vec!["alex".into()],
            reviewers: vec!["you".into(), "jamie".into()],
            team: "Integrations".into(),
            repo: "navigo".into(),
            source_branch: "feature/jira-branch".into(),
            target_branch: "main".into(),
            status: "open".into(),
            url: "https://github.com/example/navigo/pull/77".into(),
            labels: vec!["jira".into(), "workflow".into()],
            updated_at: "2026-07-18T09:45:00Z".into(),
            draft: false,
            review_state: "pending".into(),
            pipeline_status: "pending".into(),
            additions: 300,
            deletions: 55,
            comment_count: 8,
            is_mine: false,
        },
        MockPullRequest {
            id: "pr-70".into(),
            number: 70,
            title: "Docs: onboarding SSH checklist".into(),
            author: "sam".into(),
            assignees: vec![],
            reviewers: vec!["you".into()],
            team: "Product".into(),
            repo: "branchline".into(),
            source_branch: "docs/onboarding-ssh".into(),
            target_branch: "main".into(),
            status: "open".into(),
            url: "https://github.com/example/branchline/pull/70".into(),
            labels: vec!["docs".into()],
            updated_at: "2026-07-14T12:00:00Z".into(),
            draft: true,
            review_state: "pending".into(),
            pipeline_status: "success".into(),
            additions: 90,
            deletions: 5,
            comment_count: 0,
            is_mine: false,
        },
    ]
}

pub fn list_mock_jira_issues() -> Vec<MockJiraIssue> {
    vec![
        MockJiraIssue {
            key: "BL-214".into(),
            summary: "Cherry-pick preview should estimate conflicts".into(),
            status: "In Progress".into(),
            assignee: "Alex Rivera".into(),
            priority: "High".into(),
            issue_type: "Story".into(),
            url: "https://jira.example.com/browse/BL-214".into(),
            updated_at: "2026-07-18T08:00:00Z".into(),
            labels: vec!["git".into(), "ux".into()],
        },
        MockJiraIssue {
            key: "BL-201".into(),
            summary: "Persist layout per repository".into(),
            status: "Done".into(),
            assignee: "Jamie Chen".into(),
            priority: "Medium".into(),
            issue_type: "Task".into(),
            url: "https://jira.example.com/browse/BL-201".into(),
            updated_at: "2026-07-15T16:20:00Z".into(),
            labels: vec!["settings".into()],
        },
        MockJiraIssue {
            key: "BL-188".into(),
            summary: "External merge tool launch for conflicts".into(),
            status: "To Do".into(),
            assignee: "Unassigned".into(),
            priority: "High".into(),
            issue_type: "Bug".into(),
            url: "https://jira.example.com/browse/BL-188".into(),
            updated_at: "2026-07-10T11:05:00Z".into(),
            labels: vec!["diff".into(), "conflicts".into()],
        },
    ]
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
