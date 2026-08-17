//! The session rail.
//!
//! Two axes, both the user's to set: scope (this project, or everywhere Pi has
//! run) and grouping (by date, by project, or not at all). Together they turn
//! the rail from a list of one folder's chats into the way you move between
//! projects.
//!
//! The row model is deliberately *flat* — a `Vec<Row>` of headers and sessions
//! rather than a tree of groups. That is what makes the rail both virtualizable
//! and regroupable at once: switching from "date" to "project" changes which
//! headers get emitted and nothing else, and the virtualizer only ever sees a
//! list of heights.
//!
//! Virtualized because a long-lived install accumulates hundreds of sessions
//! and this list is on screen the whole time. Paying full layout for rows
//! nobody can see is the cost the window can least afford while tokens are
//! streaming next door.

use std::collections::HashSet;
use std::rc::Rc;
use std::time::{Duration, SystemTime};

use gpui::prelude::*;
use gpui::{
    actions, div, px, App, Context, Corner, Entity, EventEmitter, FocusHandle, Focusable,
    MouseButton, PathPromptOptions, Pixels, SharedString, Size, Window,
};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::input::{Input, InputEvent, InputState};
use gpui_component::skeleton::Skeleton;
use gpui_component::tooltip::Tooltip;
use gpui_component::menu::DropdownMenu;
use gpui_component::{v_virtual_list, Icon, IconName, Sizable};

use crate::fuzzy;
use crate::prefs::Prefs;
use crate::sessions::{relative, SessionEntry};
use crate::theme::{space, text, Theme};
use crate::ui::{clip, workspace_name};

actions!(
    rail,
    [
        ScopeWorkspace,
        ScopeAll,
        SortRecent,
        SortName,
        SortLength,
        GroupDate,
        GroupProject,
        GroupNothing,
        ExpandGroups,
    ]
);

/// Which sessions the rail is showing.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Workspace,
    All,
}

impl Scope {
    fn from_pref(value: &str) -> Self {
        if value == "all" { Self::All } else { Self::Workspace }
    }
    fn as_pref(self) -> String {
        match self {
            Self::All => "all".into(),
            Self::Workspace => "workspace".into(),
        }
    }
}

impl GroupBy {
    fn from_pref(value: &str) -> Self {
        match value {
            "project" => Self::Project,
            "none" => Self::Nothing,
            _ => Self::Date,
        }
    }
    fn as_pref(self) -> String {
        match self {
            Self::Project => "project".into(),
            Self::Nothing => "none".into(),
            Self::Date => "date".into(),
        }
    }
}

impl SortBy {
    fn from_pref(value: &str) -> Self {
        match value {
            "name" => Self::Name,
            "length" => Self::Length,
            _ => Self::Recent,
        }
    }
    fn as_pref(self) -> String {
        match self {
            Self::Name => "name".into(),
            Self::Length => "length".into(),
            Self::Recent => "recent".into(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum GroupBy {
    Date,
    Project,
    Nothing,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SortBy {
    Recent,
    Name,
    Length,
}

/// One line of the rail. Headers and sessions share the list so the whole
/// thing can go through a single virtualizer.
enum Row {
    Header {
        key: String,
        label: String,
        count: usize,
        collapsed: bool,
        /// Headers for a search result set are counts, not groups, so they do
        /// not collapse.
        collapsible: bool,
    },
    Session(SessionEntry),
}

const ROW_HEIGHT: Pixels = px(44.0);
const HEADER_HEIGHT: Pixels = px(26.0);
/// Width reserved on a session row for the relative time, which is drawn over
/// the title rather than beside it. Wide enough for the longest form ("Mar 4").
const TIME_COLUMN: f32 = 42.0;

/// Buckets in the order they are shown. Newest first, because that is the
/// order the eye searches a rail in.
const TIME_ORDER: [&str; 5] = ["Today", "Yesterday", "This week", "This month", "Earlier"];

pub enum RailEvent {
    Open(String),
    NewSession,
    /// The scope changed; the shell owns the index and has to rescan.
    ScopeChanged(Scope),
    /// Point the whole window at a different folder.
    OpenWorkspace(String),
}

pub struct Rail {
    theme: Theme,
    query: Entity<InputState>,
    sessions: Vec<SessionEntry>,
    rows: Vec<Row>,
    /// One height per row, handed to the virtualizer. Rebuilt with `rows`.
    sizes: Rc<Vec<Size<Pixels>>>,
    active: Option<String>,
    workspace: String,
    pub scope: Scope,
    group_by: GroupBy,
    sort_by: SortBy,
    collapsed: HashSet<String>,
    /// True until the first scan lands, so an empty list can say "still
    /// looking" rather than "nothing here".
    loading: bool,
    /// Where the menu's actions are dispatched. `PopupMenu` returns focus here
    /// before firing, so the handlers below receive them.
    focus: FocusHandle,
}

impl Focusable for Rail {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl EventEmitter<RailEvent> for Rail {}

impl Rail {
    pub fn new(theme: Theme, window: &mut Window, cx: &mut Context<Self>) -> Self {
        // Restored rather than defaulted: scope and grouping are how someone
        // has decided to think about their sessions, and re-deciding it every
        // launch is the kind of small tax that makes an app feel disposable.
        let prefs = Prefs::load();
        let scope = Scope::from_pref(&prefs.rail_scope);

        let query = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(match scope {
                    Scope::Workspace => "Search this project",
                    Scope::All => "Search every project",
                })
                .clean_on_escape()
        });

        cx.subscribe(&query, |rail, _state, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                rail.rebuild(cx);
            }
        })
        .detach();

        Self {
            theme,
            query,
            sessions: Vec::new(),
            rows: Vec::new(),
            sizes: Rc::new(Vec::new()),
            active: None,
            workspace: String::new(),
            scope,
            group_by: GroupBy::from_pref(&prefs.rail_group_by),
            sort_by: SortBy::from_pref(&prefs.rail_sort_by),
            collapsed: prefs.collapsed_groups.iter().cloned().collect(),
            loading: true,
            focus: cx.focus_handle(),
        }
    }

    /// Hand the rail a fresh scan.
    pub fn set_sessions(&mut self, sessions: Vec<SessionEntry>, cx: &mut Context<Self>) {
        self.sessions = sessions;
        self.loading = false;
        self.rebuild(cx);
    }

    pub fn set_active(&mut self, active: Option<String>, workspace: String, cx: &mut Context<Self>) {
        if self.active == active && self.workspace == workspace {
            return;
        }
        self.active = active;
        self.workspace = workspace;
        cx.notify();
    }

    /// True when the rail's controls are off their defaults — the trigger
    /// carries a dot in that case, which is the only signal needed at rest.
    fn adjusted(&self) -> bool {
        self.scope != Scope::Workspace
            || self.group_by != GroupBy::Date
            || self.sort_by != SortBy::Recent
    }

    /// Rebuild the flat row list and the height table that mirrors it.
    fn rebuild(&mut self, cx: &mut Context<Self>) {
        let needle = self.query.read(cx).value().trim().to_string();
        self.rows = build_rows(
            &self.sessions,
            &needle,
            self.group_by,
            self.sort_by,
            &self.collapsed,
            &self.workspace,
        );
        self.sizes = Rc::new(
            self.rows
                .iter()
                .map(|row| Size {
                    width: px(0.0),
                    height: match row {
                        Row::Header { .. } => HEADER_HEIGHT,
                        Row::Session(_) => ROW_HEIGHT,
                    },
                })
                .collect(),
        );
        cx.notify();
    }

    fn toggle_group(&mut self, key: &str, cx: &mut Context<Self>) {
        if !self.collapsed.remove(key) {
            self.collapsed.insert(key.to_string());
        }
        self.remember();
        self.rebuild(cx);
    }

    /// Write the rail's four settings back to disk.
    ///
    /// Called from every mutation rather than on quit: a window that is force
    /// quit, or that crashes, should still have remembered the last thing you
    /// told it. The file is four fields, so the write is cheaper than
    /// tracking whether one is needed.
    fn set_scope(&mut self, next: Scope, window: &mut Window, cx: &mut Context<Self>) {
        if self.scope == next {
            return;
        }
        self.scope = next;
        self.sync_placeholder(window, cx);
        self.remember();
        cx.emit(RailEvent::ScopeChanged(next));
        self.rebuild(cx);
    }

    fn set_group_by(&mut self, next: GroupBy, cx: &mut Context<Self>) {
        self.group_by = next;
        self.remember();
        self.rebuild(cx);
    }

    fn set_sort_by(&mut self, next: SortBy, cx: &mut Context<Self>) {
        self.sort_by = next;
        self.remember();
        self.rebuild(cx);
    }

    /// Ask the system for a folder, then hand it to the shell.
    ///
    /// The prompt is a real NSOpenPanel, so it comes with the sidebar of
    /// favourites, recent places, and typing a path with `/` — none of which is
    /// worth rebuilding inside the window.
    fn pick_workspace(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Open".into()),
        });

        cx.spawn(async move |rail, cx| {
            // Three layers of "maybe": the channel can drop, the panel can
            // fail, and the user can cancel. All three mean the same thing
            // here — carry on with the folder we have.
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            let Some(path) = paths.first().map(|p| p.to_string_lossy().to_string()) else {
                return;
            };
            let _ = rail.update(cx, |_rail, cx| {
                cx.emit(RailEvent::OpenWorkspace(path));
            });
        })
        .detach();
    }

    /// The placeholder names the scope, so the field says what a search will
    /// actually cover before anyone types into it and is surprised.
    fn sync_placeholder(&self, window: &mut Window, cx: &mut App) {
        let label = match self.scope {
            Scope::Workspace => "Search this project",
            Scope::All => "Search every project",
        };
        self.query.update(cx, |state, cx| {
            state.set_placeholder(label, window, cx);
        });
    }

    fn remember(&self) {
        Prefs {
            rail_scope: self.scope.as_pref(),
            rail_group_by: self.group_by.as_pref(),
            rail_sort_by: self.sort_by.as_pref(),
            collapsed_groups: self.collapsed.iter().cloned().collect(),
        }
        .save();
    }
}

/// Fold the scan into the flat list the rail renders.
fn build_rows(
    sessions: &[SessionEntry],
    query: &str,
    group_by: GroupBy,
    sort_by: SortBy,
    collapsed: &HashSet<String>,
    active_cwd: &str,
) -> Vec<Row> {
    let mut ordered: Vec<SessionEntry> = sessions.to_vec();
    match sort_by {
        SortBy::Name => ordered.sort_by(|a, b| a.title().to_lowercase().cmp(&b.title().to_lowercase())),
        SortBy::Length => ordered.sort_by(|a, b| b.messages.cmp(&a.messages)),
        SortBy::Recent => ordered.sort_by(|a, b| b.modified.cmp(&a.modified)),
    }

    if !query.is_empty() {
        // Searching reaches the project name too, so "mako" finds a session in
        // that repo without first widening the scope to it.
        let mut scored: Vec<(i32, SessionEntry)> = ordered
            .into_iter()
            .filter_map(|entry| {
                let haystack = format!(
                    "{} {} {}",
                    entry.name,
                    entry.first_message,
                    workspace_name(&entry.cwd)
                );
                fuzzy::score(query, &haystack).map(|score| (score, entry))
            })
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0));

        let count = scored.len();
        let mut rows = vec![Row::Header {
            key: "results".into(),
            label: if count == 1 {
                "1 match".into()
            } else {
                format!("{count} matches")
            },
            count,
            collapsed: false,
            collapsible: false,
        }];
        rows.extend(scored.into_iter().map(|(_, entry)| Row::Session(entry)));
        return rows;
    }

    match group_by {
        GroupBy::Nothing => ordered.into_iter().map(Row::Session).collect(),

        GroupBy::Project => {
            // Preserve the sorted order inside each group by walking the list
            // once and appending, rather than collecting into a map first.
            let mut groups: Vec<(String, Vec<SessionEntry>)> = Vec::new();
            for entry in ordered {
                match groups.iter_mut().find(|(cwd, _)| *cwd == entry.cwd) {
                    Some((_, list)) => list.push(entry),
                    None => groups.push((entry.cwd.clone(), vec![entry])),
                }
            }
            // The project you are in sorts first; the rest by latest activity,
            // which the input order already reflects.
            groups.sort_by_key(|(cwd, _)| cwd != active_cwd);

            let mut rows = Vec::new();
            for (cwd, group) in groups {
                let key = format!("project:{cwd}");
                let down = collapsed.contains(&key);
                rows.push(Row::Header {
                    label: workspace_name(&cwd),
                    count: group.len(),
                    collapsed: down,
                    collapsible: true,
                    key,
                });
                if down {
                    continue;
                }
                rows.extend(group.into_iter().map(Row::Session));
            }
            rows
        }

        GroupBy::Date => {
            let mut buckets: Vec<(usize, Vec<SessionEntry>)> = Vec::new();
            for entry in ordered {
                let bucket = bucket_of(entry.modified);
                match buckets.iter_mut().find(|(index, _)| *index == bucket) {
                    Some((_, list)) => list.push(entry),
                    None => buckets.push((bucket, vec![entry])),
                }
            }
            buckets.sort_by_key(|(index, _)| *index);

            let mut rows = Vec::new();
            for (index, group) in buckets {
                let key = format!("time:{}", TIME_ORDER[index]);
                let down = collapsed.contains(&key);
                rows.push(Row::Header {
                    label: TIME_ORDER[index].to_string(),
                    count: group.len(),
                    collapsed: down,
                    collapsible: true,
                    key,
                });
                if down {
                    continue;
                }
                rows.extend(group.into_iter().map(Row::Session));
            }
            rows
        }
    }
}

/// Which time bucket a session falls in, as an index into `TIME_ORDER`.
///
/// Measured from *midnight*, not from now: something written at 23:50 last
/// night is "yesterday" at 00:10 today, not "twenty minutes ago". Elapsed time
/// is the wrong unit for a bucket a human reads as a calendar day.
fn bucket_of(modified: SystemTime) -> usize {
    let Ok(since_midnight) = SystemTime::now().duration_since(midnight_today()) else {
        return 4;
    };
    let Ok(elapsed) = SystemTime::now().duration_since(modified) else {
        return 0;
    };
    if elapsed <= since_midnight {
        return 0; // Today
    }
    let days_before_today = (elapsed - since_midnight).as_secs() / 86_400;
    match days_before_today {
        0 => 1, // Yesterday
        1..=5 => 2,
        6..=28 => 3,
        _ => 4,
    }
}

/// Local midnight, derived from the clock rather than a calendar library:
/// `SystemTime` has no timezone, so this uses the offset the platform reports
/// for the current moment.
fn midnight_today() -> SystemTime {
    let now = SystemTime::now();
    let since_epoch = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs() as i64;
    let local = since_epoch + local_offset_seconds();
    let seconds_into_day = local.rem_euclid(86_400);
    now - Duration::from_secs(seconds_into_day as u64)
}

/// Seconds east of UTC, read once from libc's own view of local time.
fn local_offset_seconds() -> i64 {
    // SAFETY: `localtime_r` writes into a caller-owned `tm` and takes no
    // global lock; `tm_gmtoff` is the platform's offset for that instant.
    unsafe {
        let now: i64 = std::time::UNIX_EPOCH
            .elapsed()
            .unwrap_or(Duration::ZERO)
            .as_secs() as i64;
        let mut out: Tm = std::mem::zeroed();
        localtime_r(&now, &mut out);
        out.tm_gmtoff
    }
}

#[repr(C)]
struct Tm {
    tm_sec: i32,
    tm_min: i32,
    tm_hour: i32,
    tm_mday: i32,
    tm_mon: i32,
    tm_year: i32,
    tm_wday: i32,
    tm_yday: i32,
    tm_isdst: i32,
    tm_gmtoff: i64,
    tm_zone: *const i8,
}

extern "C" {
    fn localtime_r(time: *const i64, result: *mut Tm) -> *mut Tm;
}

impl Render for Rail {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme.clone();

        div()
            .key_context("Rail")
            .track_focus(&self.focus)
            .on_action(cx.listener(|rail, _: &ScopeWorkspace, window, cx| {
                rail.set_scope(Scope::Workspace, window, cx)
            }))
            .on_action(cx.listener(|rail, _: &ScopeAll, window, cx| {
                rail.set_scope(Scope::All, window, cx)
            }))
            .on_action(cx.listener(|rail, _: &SortRecent, _w, cx| {
                rail.set_sort_by(SortBy::Recent, cx)
            }))
            .on_action(cx.listener(|rail, _: &SortName, _w, cx| {
                rail.set_sort_by(SortBy::Name, cx)
            }))
            .on_action(cx.listener(|rail, _: &SortLength, _w, cx| {
                rail.set_sort_by(SortBy::Length, cx)
            }))
            .on_action(cx.listener(|rail, _: &GroupDate, _w, cx| {
                rail.set_group_by(GroupBy::Date, cx)
            }))
            .on_action(cx.listener(|rail, _: &GroupProject, _w, cx| {
                rail.set_group_by(GroupBy::Project, cx)
            }))
            .on_action(cx.listener(|rail, _: &GroupNothing, _w, cx| {
                rail.set_group_by(GroupBy::Nothing, cx)
            }))
            .on_action(cx.listener(|rail, _: &ExpandGroups, _w, cx| {
                rail.collapsed.clear();
                rail.remember();
                rail.rebuild(cx);
            }))
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .bg(theme.panel)
            .border_r_1()
            .border_color(theme.hairline)
            .child(self.header(&theme, cx))
            .child(self.search(&theme, cx))
            .child(self.body(&theme, cx))
    }
}

impl Rail {
    fn header(&self, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(4.0))
            .h(px(36.0))
            .px(px(8.0))
            .border_b_1()
            .border_color(theme.hairline)
            // The workspace name is the control for changing it. A folder is
            // the one piece of global state in this window — it decides which
            // sessions exist and which files the agent can touch — so it is
            // worth a click from where it is already displayed.
            .child(
                div()
                    .id("rail-workspace")
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .gap(px(6.0))
                    .h(px(26.0))
                    .px(px(5.0))
                    .rounded(space::RADIUS)
                    .hover(|style| style.bg(theme.raised.opacity(0.7)))
                    .tooltip({
                        let cwd = self.workspace.clone();
                        move |window, cx| {
                            Tooltip::new(format!("{cwd}\nOpen a different folder"))
                                .build(window, cx)
                        }
                    })
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|rail, _event, _window, cx| rail.pick_workspace(cx)),
                    )
                    .child(
                        Icon::new(IconName::Folder)
                            .size(px(13.0))
                            .text_color(theme.faint),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(text::UI)
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(theme.foreground)
                            .child(SharedString::from(workspace_name(&self.workspace))),
                    )
                    .child(
                        Icon::new(IconName::ChevronsUpDown)
                            .size(px(10.0))
                            .text_color(theme.faint.opacity(0.8)),
                    ),
            )
            .child(
                Button::new("rail-new")
                    .ghost()
                    .xsmall()
                    .icon(IconName::Plus)
                    .tooltip("New session  ⌘N")
                    .on_click(cx.listener(|_rail, _event, _window, cx| {
                        cx.emit(RailEvent::NewSession);
                    })),
            )
    }

    fn search(&self, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        let has_query = !self.query.read(cx).value().is_empty();

        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(4.0))
            .px(px(8.0))
            .py(px(7.0))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .gap(px(6.0))
                    .h(px(27.0))
                    .px(px(7.0))
                    .rounded(space::RADIUS)
                    .bg(theme.raised.opacity(0.7))
                    .child(
                        Icon::new(IconName::Search)
                            .size(px(12.0))
                            .text_color(theme.faint),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(text::UI)
                            .child(Input::new(&self.query).appearance(false).xsmall()),
                    )
                    // Only present when there is something to clear. Escape
                    // does the same thing from the keyboard.
                    .when(has_query, |field| {
                        field.child(
                            Button::new("rail-clear")
                                .ghost()
                                .xsmall()
                                .icon(IconName::Close)
                                .tooltip("Clear  ⎋")
                                .on_click(cx.listener(|rail, _event, window, cx| {
                                    rail.query.update(cx, |state, cx| {
                                        state.set_value("", window, cx);
                                    });
                                    rail.rebuild(cx);
                                })),
                        )
                    }),
            )
            .child(self.options(cx))
    }

    /// Scope, sort, and grouping — behind one button rather than as visible
    /// switches. They are set rarely and read never, so spending a row of the
    /// rail on them takes space from the list they exist to organise.
    ///
    /// Built on the library's `dropdown_menu` rather than a hand-rolled
    /// popover. The hand-rolled one had to reimplement dismissal, and did it
    /// badly: choosing an item left the menu open, because nothing in a plain
    /// `Popover` knows that a click on your content was a *choice*. `PopupMenu`
    /// knows, and brings keyboard navigation and check marks with it.
    fn options(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let scope = self.scope;
        let group_by = self.group_by;
        let sort_by = self.sort_by;
        let adjusted = self.adjusted();
        let collapsed_any = !self.collapsed.is_empty();
        let focus = self.focus.clone();

        div()
            .relative()
            .flex_none()
            .child(
                Button::new("rail-options")
                    .ghost()
                    .xsmall()
                    .icon(IconName::Settings2)
                    .tooltip("Scope, sort, and grouping")
                    .dropdown_menu_with_anchor(Corner::TopRight, move |menu, _window, _cx| {
                        // Actions rather than closures, so every one of these
                        // is also a thing the command palette and a key binding
                        // can reach without a second implementation.
                        let menu = menu
                            .action_context(focus.clone())
                            .label("Show")
                            .menu_with_check(
                                "This project",
                                scope == Scope::Workspace,
                                Box::new(ScopeWorkspace),
                            )
                            .menu_with_check("All projects", scope == Scope::All, Box::new(ScopeAll))
                            .separator()
                            .label("Sort by")
                            .menu_with_check(
                                "Last used",
                                sort_by == SortBy::Recent,
                                Box::new(SortRecent),
                            )
                            .menu_with_check("Name", sort_by == SortBy::Name, Box::new(SortName))
                            .menu_with_check(
                                "Length",
                                sort_by == SortBy::Length,
                                Box::new(SortLength),
                            )
                            .separator()
                            .label("Group by")
                            .menu_with_check("Date", group_by == GroupBy::Date, Box::new(GroupDate))
                            .menu_with_check(
                                "Project",
                                group_by == GroupBy::Project,
                                Box::new(GroupProject),
                            )
                            .menu_with_check(
                                "Nothing",
                                group_by == GroupBy::Nothing,
                                Box::new(GroupNothing),
                            );

                        if collapsed_any {
                            menu.separator()
                                .menu("Expand all groups", Box::new(ExpandGroups))
                        } else {
                            menu
                        }
                    }),
            )
            // The dot is the whole point of hiding these behind a button: at
            // rest it is the only thing that has to say the list is not showing
            // you everything, in its default order.
            .when(adjusted, |wrap| {
                wrap.child(
                    div()
                        .absolute()
                        .top(px(2.0))
                        .right(px(2.0))
                        .size(px(4.0))
                        .rounded_full()
                        .bg(self.theme.foreground.opacity(0.75)),
                )
            })
    }

    fn body(&self, theme: &Theme, cx: &mut Context<Self>) -> gpui::AnyElement {
        if self.loading && self.sessions.is_empty() {
            return self.skeletons(theme).into_any_element();
        }
        if self.rows.is_empty() {
            return self.blank(theme, cx).into_any_element();
        }

        let entity = cx.entity();
        let theme = theme.clone();
        let active = self.active.clone();
        let show_project = self.scope == Scope::All && self.group_by != GroupBy::Project;

        div()
            .flex_1()
            .min_h_0()
            .px(px(6.0))
            .child(v_virtual_list(
                entity,
                "rail-rows",
                self.sizes.clone(),
                move |rail: &mut Rail, range, _window, cx| {
                    range
                        .map(|index| match &rail.rows[index] {
                            Row::Header {
                                key,
                                label,
                                count,
                                collapsed,
                                collapsible,
                            } => header_row(
                                &theme, key, label, *count, *collapsed, *collapsible, index, cx,
                            )
                            .into_any_element(),
                            Row::Session(entry) => session_row(
                                &theme,
                                entry,
                                active.as_deref() == Some(entry.path.to_string_lossy().as_ref()),
                                show_project,
                                index,
                                cx,
                            )
                            .into_any_element(),
                        })
                        .collect()
                },
            ))
            .into_any_element()
    }

    /// Varied widths, because real session titles are not all the same length,
    /// and staggered opacity so the list reads as filling in rather than as one
    /// block flashing.
    fn skeletons(&self, _theme: &Theme) -> impl IntoElement {
        const WIDTHS: [(f32, f32); 5] = [
            (0.62, 0.38),
            (0.48, 0.30),
            (0.70, 0.44),
            (0.40, 0.26),
            (0.56, 0.34),
        ];

        div()
            .flex()
            .flex_col()
            .px(px(10.0))
            .pt(px(4.0))
            .children(WIDTHS.iter().enumerate().map(|(index, (title, meta))| {
                div()
                    .h(ROW_HEIGHT)
                    .flex()
                    .flex_col()
                    .justify_center()
                    .gap(px(6.0))
                    .opacity(1.0 - index as f32 * 0.16)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(Skeleton::new().h(px(10.0)).w(gpui::relative(*title)))
                            .child(div().flex_1())
                            .child(Skeleton::new().secondary().h(px(8.0)).w(px(22.0))),
                    )
                    .child(Skeleton::new().secondary().h(px(8.0)).w(gpui::relative(*meta)))
            }))
    }

    /// Nothing to show — but *why* there is nothing changes what to offer.
    fn blank(&self, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        let searching = !self.query.read(cx).value().trim().is_empty();
        let narrow = self.scope == Scope::Workspace;

        let (title, body) = match (searching, narrow) {
            (true, true) => (
                "No matches here",
                "Nothing in this project matches. Try searching every project.",
            ),
            (true, false) => ("No matches", "Try a different term."),
            (false, _) => (
                "No sessions yet",
                "Start one in this folder — Pi keeps the history, Mako just makes it visible.",
            ),
        };

        div()
            .flex()
            .flex_1()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(6.0))
            .px(px(22.0))
            .pb(px(40.0))
            .child(
                Icon::new(IconName::Inbox)
                    .size(px(18.0))
                    .text_color(theme.faint.opacity(0.7)),
            )
            .child(
                div()
                    .text_size(text::UI)
                    .text_color(theme.muted)
                    .child(title),
            )
            .child(
                div()
                    .text_size(text::MICRO)
                    .text_center()
                    .line_height(px(15.0))
                    .text_color(theme.faint)
                    .child(body),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .mt(px(4.0))
                    .when(!searching, |actions| {
                        actions.child(
                            Button::new("blank-new")
                                .outline()
                                .xsmall()
                                .label("New session")
                                .on_click(cx.listener(|_rail, _event, _window, cx| {
                                    cx.emit(RailEvent::NewSession);
                                })),
                        )
                    })
                    // Offered whenever the rail is narrowed and empty, not only
                    // while searching. A fresh checkout has no sessions of its
                    // own and every session you have ever had is one click
                    // away — saying so beats an empty panel that reads as
                    // "Mako found nothing".
                    .when(narrow, |actions| {
                        actions.child(
                            Button::new("widen-scope")
                                .ghost()
                                .xsmall()
                                .label(if searching {
                                    "Search every project"
                                } else {
                                    "Look in every project"
                                })
                                .on_click(cx.listener(|rail, _event, window, cx| {
                                    rail.scope = Scope::All;
                                    rail.sync_placeholder(window, cx);
                                    rail.remember();
                                    cx.emit(RailEvent::ScopeChanged(Scope::All));
                                    cx.notify();
                                })),
                        )
                    }),
            )
    }
}

fn section(theme: &Theme, label: &'static str) -> impl IntoElement {
    div()
        .px(px(8.0))
        .pt(px(6.0))
        .pb(px(3.0))
        .text_size(text::MICRO)
        .text_color(theme.faint)
        .child(label)
}

fn divider(theme: &Theme) -> impl IntoElement {
    div().my(px(4.0)).h(px(1.0)).bg(theme.hairline)
}

/// One line of the options menu. `slot` identifies which setting it drives,
/// which keeps the menu a table of data rather than eight near-identical
/// closures.
fn option_row(
    theme: &Theme,
    rail: &Entity<Rail>,
    slot: usize,
    label: &'static str,
    hint: &'static str,
    selected: bool,
) -> impl IntoElement {
    let rail = rail.clone();
    let theme = theme.clone();

    div()
        .id(("rail-option", slot))
        .flex()
        .items_center()
        .gap(px(8.0))
        .rounded(space::RADIUS)
        .px(px(8.0))
        .py(px(6.0))
        .hover(|style| style.bg(theme.hover()))
        .on_mouse_down(MouseButton::Left, move |_event, window, cx| {
            rail.update(cx, |rail, cx| {
                match slot {
                    0 | 1 => {
                        let next = if slot == 0 { Scope::Workspace } else { Scope::All };
                        rail.scope = next;
                        rail.sync_placeholder(window, cx);
                        cx.emit(RailEvent::ScopeChanged(next));
                    }
                    2 => rail.sort_by = SortBy::Recent,
                    3 => rail.sort_by = SortBy::Name,
                    4 => rail.sort_by = SortBy::Length,
                    5 => rail.group_by = GroupBy::Date,
                    6 => rail.group_by = GroupBy::Project,
                    _ => rail.group_by = GroupBy::Nothing,
                }
                rail.remember();
                rail.rebuild(cx);
            });
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .truncate()
                        .text_size(text::UI)
                        .when(selected, |line| {
                            line.font_weight(gpui::FontWeight::MEDIUM)
                        })
                        .text_color(if selected {
                            theme.foreground
                        } else {
                            theme.foreground.opacity(0.85)
                        })
                        .child(label),
                )
                .child(
                    div()
                        .truncate()
                        .text_size(text::MICRO)
                        .text_color(theme.faint)
                        .child(hint),
                ),
        )
        .when(selected, |row| {
            row.child(
                Icon::new(IconName::Check)
                    .size(px(12.0))
                    .text_color(theme.foreground.opacity(0.7)),
            )
        })
}

fn header_row(
    theme: &Theme,
    key: &str,
    label: &str,
    count: usize,
    collapsed: bool,
    collapsible: bool,
    index: usize,
    cx: &mut Context<Rail>,
) -> impl IntoElement {
    let key = key.to_string();

    div()
        .id(("rail-header", index))
        .flex()
        .h_full()
        .w_full()
        .items_center()
        .gap(px(4.0))
        .rounded(space::RADIUS_SM)
        .px(px(4.0))
        .when(collapsible, |row| {
            row.hover(|style| style.bg(theme.raised.opacity(0.6)))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |rail, _event, _window, cx| {
                        rail.toggle_group(&key, cx);
                    }),
                )
        })
        .child(if collapsible {
            Icon::new(if collapsed {
                IconName::ChevronRight
            } else {
                IconName::ChevronDown
            })
            .size(px(11.0))
            .text_color(theme.faint)
            .into_any_element()
        } else {
            div().w(px(11.0)).into_any_element()
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(text::SMALL)
                .font_weight(gpui::FontWeight::MEDIUM)
                .text_color(theme.faint)
                .child(SharedString::from(label.to_string())),
        )
        .child(
            div()
                .pr(px(4.0))
                .text_size(text::MICRO)
                .text_color(theme.faint.opacity(0.7))
                .child(SharedString::from(count.to_string())),
        )
}

fn session_row(
    theme: &Theme,
    entry: &SessionEntry,
    active: bool,
    show_project: bool,
    index: usize,
    cx: &mut Context<Rail>,
) -> impl IntoElement {
    let path = entry.path.to_string_lossy().to_string();
    // When a session has a name of its own, the first thing asked is still
    // worth showing underneath — it is what people actually recognise a
    // session by. Otherwise the title already *is* that line, so the second
    // line falls back to the size of the conversation.
    let detail = if entry.name.is_empty() {
        format!("{} messages", entry.messages)
    } else {
        clip(&entry.first_message, 60)
    };

    div()
        .id(("rail-session", index))
        .relative()
        .flex()
        .h_full()
        .w_full()
        .flex_col()
        .justify_center()
        .gap(px(2.0))
        .rounded(space::RADIUS)
        .px(px(8.0))
        .when(active, |row| row.bg(theme.raised))
        .hover(|style| style.bg(theme.raised.opacity(0.75)))
        // The row shows a project name at most; the full path is what
        // disambiguates two checkouts of the same repo, and it belongs on
        // hover rather than in a column nobody has room for.
        .tooltip({
            let cwd = entry.cwd.clone();
            move |window, cx| Tooltip::new(cwd.clone()).build(window, cx)
        })
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |_rail, _event, _window, cx| {
                cx.emit(RailEvent::Open(path.clone()));
            }),
        )
        // An accent bar rather than a heavier fill: a selected row should read
        // as marked, not as a different kind of surface.
        .when(active, |row| {
            row.child(
                div()
                    .absolute()
                    .left(px(-2.0))
                    .top(px(8.0))
                    .bottom(px(8.0))
                    .w(px(2.0))
                    .rounded_full()
                    .bg(theme.foreground.opacity(0.7)),
            )
        })
        // The title takes the full row width with the age's column reserved as
        // padding, and the age is placed over it, rather than the two being
        // flex siblings. That is not a style choice: GPUI only ellipsizes text
        // whose width is *definite* when it is measured, and a `flex_1` child
        // is first measured unconstrained — the result is then cached, so it
        // never truncates and the row just clips mid-word instead.
        .child(
            div()
                .w_full()
                .pr(px(TIME_COLUMN))
                .truncate()
                .text_size(text::UI)
                .when(active, |line| line.font_weight(gpui::FontWeight::MEDIUM))
                .text_color(if active {
                    theme.foreground
                } else {
                    theme.foreground.opacity(0.85)
                })
                .child(SharedString::from(clip(entry.title(), 90))),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .w_full()
                .text_size(text::SMALL)
                .text_color(theme.faint)
                .when(show_project, |line| {
                    line.child(
                        div()
                            .flex_none()
                            .rounded(space::RADIUS_SM)
                            .bg(theme.raised)
                            .px(px(4.0))
                            .text_size(text::MICRO)
                            .text_color(theme.muted)
                            .child(SharedString::from(workspace_name(&entry.cwd))),
                    )
                })
                .child(
                    div()
                        .w_full()
                        .truncate()
                        .child(SharedString::from(detail)),
                ),
        )
        // Positioned against the title *line* rather than nudged by eye, so it
        // stays aligned if either type size moves.
        .child(
            div()
                .absolute()
                .top(px(0.0))
                .bottom(px(0.0))
                .right(px(8.0))
                .flex()
                .flex_col()
                .justify_center()
                .child(
                    div()
                        .mb(px(17.0))
                        .text_size(text::MICRO)
                        .text_color(theme.faint)
                        .child(SharedString::from(relative(entry.modified))),
                ),
        )
}
