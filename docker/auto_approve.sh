#!/bin/bash
# auto_approve.sh — Auto-approves all Claude permission prompts in tmux session
SESSION="${1:?Usage: $0 <tmux-session-name>}"
PANE="${SESSION}:0.0"

echo "[$SESSION] Auto-approver starting for pane: $PANE"

# Wait for session to appear (up to 30s)
for i in $(seq 1 30); do
    if tmux has-session -t "$SESSION" 2>/dev/null; then
        echo "[$SESSION] Session found after ${i}s"
        break
    fi
    if [[ $i -eq 30 ]]; then
        echo "[$SESSION] Session never appeared, exiting"
        exit 1
    fi
    sleep 1
done

while true; do
    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
        echo "[$SESSION] Session ended, exiting"
        exit 0
    fi

    content=$(tmux capture-pane -t "$PANE" -p 2>/dev/null)

    # Approve all permission prompts (Do you want to ... with numbered options)
    if echo "$content" | grep -q "Do you want to" && echo "$content" | grep -qE "^\s*[12][.)]\s"; then
        tmux send-keys -t "$PANE" "1"
        sleep 0.2
        tmux send-keys -t "$PANE" "Enter"
        echo "[$SESSION] $(date +%H:%M:%S) APPROVED permission prompt"

    # Approve edit prompts
    elif echo "$content" | grep -q "Do you want to make"; then
        tmux send-keys -t "$PANE" "1"
        sleep 0.2
        tmux send-keys -t "$PANE" "Enter"
        echo "[$SESSION] $(date +%H:%M:%S) APPROVED edit prompt"

    # Approve create prompts
    elif echo "$content" | grep -q "Do you want to create"; then
        tmux send-keys -t "$PANE" "1"
        sleep 0.2
        tmux send-keys -t "$PANE" "Enter"
        echo "[$SESSION] $(date +%H:%M:%S) APPROVED create prompt"
    fi

    sleep 3
done
