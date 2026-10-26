//! One bounded writer, with acknowledgements delivered only after transaction commit.
use crate::StorageError;
use sqlx::{Connection, SqliteConnection};
use std::{
    any::Any,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::sync::{Notify, mpsc, oneshot};

pub const CAPACITY: usize = 1024;
pub type WorkFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, StorageError>> + Send + 'a>>;
type Value = Box<dyn Any + Send>;
type Job = Box<dyn for<'a> FnOnce(&'a mut SqliteConnection) -> WorkFuture<'a, Value> + Send>;
struct Command {
    work: Job,
    reply: oneshot::Sender<Result<Value, StorageError>>,
}
struct State {
    accepting: AtomicBool,
    admission: Mutex<()>,
    unfinished: AtomicUsize,
    drained: Notify,
    stop: Notify,
    closed: AtomicBool,
    close_completed: Notify,
}
#[derive(Clone)]
pub struct Writer {
    sender: mpsc::Sender<Command>,
    state: Arc<State>,
}
pub struct Pending<T> {
    receiver: oneshot::Receiver<Result<Value, StorageError>>,
    marker: std::marker::PhantomData<T>,
}
impl<T: Send + 'static> Pending<T> {
    pub async fn wait(self) -> Result<T, StorageError> {
        let value = self.receiver.await.map_err(|_| StorageError::Closed)??;
        value
            .downcast::<T>()
            .map(|v| *v)
            .map_err(|_| StorageError::Invariant("writer result type"))
    }
}
impl Writer {
    pub(crate) fn start(mut connection: SqliteConnection) -> Self {
        let (sender, mut receiver) = mpsc::channel::<Command>(CAPACITY);
        let state = Arc::new(State {
            accepting: AtomicBool::new(true),
            admission: Mutex::new(()),
            stop: Notify::new(),
            unfinished: AtomicUsize::new(0),
            drained: Notify::new(),
            closed: AtomicBool::new(false),
            close_completed: Notify::new(),
        });
        let task_state = state.clone();
        tokio::spawn(async move {
            loop {
                let command = tokio::select! {
                    command = receiver.recv() => command,
                    () = task_state.stop.notified() => { receiver.close(); receiver.recv().await }
                };
                let Some(command) = command else {
                    break;
                };
                let result = match connection.begin().await {
                    Ok(mut transaction) => match (command.work)(&mut transaction).await {
                        Ok(value) => transaction
                            .commit()
                            .await
                            .map(|()| value)
                            .map_err(StorageError::from),
                        Err(error) => {
                            let _ = transaction.rollback().await;
                            Err(error)
                        }
                    },
                    Err(error) => Err(StorageError::from(error)),
                };
                let _ = command.reply.send(result);
                if task_state.unfinished.fetch_sub(1, Ordering::AcqRel) == 1 {
                    task_state.drained.notify_waiters();
                }
            }
            let _ = connection.close().await;
            task_state.closed.store(true, Ordering::Release);
            task_state.close_completed.notify_waiters();
        });
        Self { sender, state }
    }
    pub fn enqueue<T, F>(&self, work: F) -> Result<Pending<T>, StorageError>
    where
        T: Send + 'static,
        F: for<'a> FnOnce(&'a mut SqliteConnection) -> WorkFuture<'a, T> + Send + 'static,
    {
        let _gate = self
            .state
            .admission
            .lock()
            .map_err(|_| StorageError::Closed)?;
        if !self.state.accepting.load(Ordering::Acquire) {
            return Err(StorageError::Closed);
        }
        let (reply, receiver) = oneshot::channel();
        let work: Job = Box::new(move |connection| {
            Box::pin(async move { work(connection).await.map(|v| Box::new(v) as Value) })
        });
        self.state.unfinished.fetch_add(1, Ordering::AcqRel);
        if let Err(error) = self.sender.try_send(Command { work, reply }) {
            if self.state.unfinished.fetch_sub(1, Ordering::AcqRel) == 1 {
                self.state.drained.notify_waiters();
            }
            return Err(match error {
                mpsc::error::TrySendError::Full(_) => StorageError::ServiceBusy,
                mpsc::error::TrySendError::Closed(_) => StorageError::Closed,
            });
        }
        Ok(Pending {
            receiver,
            marker: std::marker::PhantomData,
        })
    }
    pub async fn execute<T, F>(&self, work: F) -> Result<T, StorageError>
    where
        T: Send + 'static,
        F: for<'a> FnOnce(&'a mut SqliteConnection) -> WorkFuture<'a, T> + Send + 'static,
    {
        self.enqueue(work)?.wait().await
    }
    pub fn is_accepting(&self) -> bool {
        self.state.accepting.load(Ordering::Acquire) && !self.sender.is_closed()
    }
    pub fn stop_admission(&self) {
        if let Ok(_gate) = self.state.admission.lock() {
            self.state.accepting.store(false, Ordering::Release);
            self.state.stop.notify_one();
        }
    }
    pub fn unfinished(&self) -> usize {
        self.state.unfinished.load(Ordering::Acquire)
    }
    pub async fn drain(&self) {
        loop {
            let notified = self.state.drained.notified();
            if self.unfinished() == 0 {
                return;
            }
            notified.await;
        }
    }
    pub fn is_closed(&self) -> bool {
        self.state.closed.load(Ordering::Acquire)
    }
    /// Wait for the owned SQLite connection to finish closing after admission stops.
    /// Transaction draining remains independent for the bounded HTTP shutdown deadline.
    pub async fn wait_closed(&self) {
        loop {
            let notified = self.state.close_completed.notified();
            if self.is_closed() {
                return;
            }
            notified.await;
        }
    }
}
