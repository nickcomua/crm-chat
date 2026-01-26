//! DisplayMessage task for showing errors/info to users.

use spacetimedb::ReducerContext;

use super::task;
use super::{Task, Taskable, TaskType};

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum MessageSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub enum DisplayMessageOutput {
    Pending,
    Dismissed,
}

#[derive(Clone, Debug, spacetimedb::SpacetimeType)]
pub struct DisplayMessage {
    pub severity: MessageSeverity,
    pub message: String,
    pub output: DisplayMessageOutput,
}

impl Taskable for DisplayMessage {
    fn validate(&self) -> Result<(), String> {
        if self.message.is_empty() {
            return Err("Message cannot be empty".to_string());
        }
        Ok(())
    }

    fn is_done(&self) -> bool {
        matches!(self.output, DisplayMessageOutput::Dismissed)
    }

    fn on_done(task: &Task, ctx: &ReducerContext) -> Result<(), String> {
        // Just delete the task when dismissed
        ctx.db.task().id().delete(task.id.clone());
        Ok(())
    }

    fn task_type(&self) -> TaskType {
        TaskType::Human
    }
}
