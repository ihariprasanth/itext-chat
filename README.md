# iText

Anonymous real-time chat. No sign-in. No database. Just pick a name, pick a room, and talk.

Open source — built by students, for anyone who wants to use, learn from, or build on it.

---

## Developers

**Hariprasanth T** — Lead Developer
Leads the overall architecture and backend of the project. Focused on WebSocket integration, server-side logic, and keeping the platform fast and reliable.
LinkedIn: https://www.linkedin.com/in/ihariprasanth/

**Sathiyapriya S** — Frontend Developer
Owns the complete frontend — UI design, responsive layouts, and the overall user experience.
LinkedIn: https://www.linkedin.com/in/sathiyapriya29/

---

## Features

- No account, no sign-in — just a username and a room name
- Real-time messaging over WebSocket
- Create any room on the fly — rooms are created the moment someone joins them
- Rooms are destroyed automatically when the last person leaves
- Live typing indicators — see when others are typing
- Online user list with live count
- Switch between multiple rooms without leaving the app
- Rename yourself mid-session using `/nick`
- Rate limiting — max 10 messages per 5 seconds per user
- XSS-safe — all message text is escaped on the client before rendering
- Mobile-first responsive UI, works on any screen size
- Subtle audio ping on new messages
- URL room sharing — share `?room=roomname` to drop anyone straight into a room

---

## Project Structure

```
itext/
├── client/                  # Frontend — served by Firebase Hosting
│   ├── index.html           # Join screen + Chat screen
│   ├── about.html           # Developers page
│   ├── app.js               # All frontend logic (vanilla JS, no frameworks)
│   ├── style.css            # Full UI styling (CSS variables, mobile-first)
│   └── assets/
│       ├── icons/
│       │   └── icon.png     # App icon
│       └── developers/
│           ├── hariprasanth.png
│           └── sathiyapriya.png
│
├── server/
│   └── server.js            # Node.js WebSocket + HTTP server
│
├── firebase.json            # Firebase Hosting config (public: client/)
├── .firebaserc              # Firebase project binding
├── package.json
└── README.md
```

---

## Frontend

Built with plain HTML, CSS, and vanilla JavaScript — zero frameworks, zero build steps.

**index.html** handles two screens in one page — the join screen and the chat screen — swapped in and out via CSS classes. No routing library needed.

**app.js** manages everything on the client side:

- WebSocket connection lifecycle (open, message, close, error)
- Join flow with username and room validation
- Sending and receiving messages
- Typing signal — debounced, auto-clears after 2 seconds of no input
- Room switching — dynamically creates room chips in the sidebar as rooms are joined
- User list rendering
- `/nick`, `/clear`, `/help` slash commands
- XSS escaping on all user-generated content before it touches the DOM
- Subtle audio ping via Web Audio API on incoming messages
- iOS viewport height fix for the keyboard pushing content up

**style.css** uses CSS custom properties throughout — one place to change the palette. Layout is mobile-first with a sidebar that slides in on small screens and is always visible on desktop.

---

## Backend

**server/server.js** — a single Node.js file. No framework, no database.

Built on the `ws` package for WebSocket and the built-in `http` module to serve static files in local development.

**In-memory room store:**

```
rooms = {
  roomName: {
    users:   { socketId: username },
    sockets: { socketId: ws }
  }
}
```

Rooms are plain objects that live in memory. When the last user leaves, the room is deleted. Nothing is persisted to disk.

**WebSocket event types the server handles:**

| Type           | What it does                                              |
|----------------|-----------------------------------------------------------|
| `join_room`    | Adds the user to a room, creates it if it doesn't exist   |
| `send_message` | Broadcasts a message to everyone in the room              |
| `typing`       | Broadcasts typing status to everyone else in the room     |
| `nick`         | Renames the user and broadcasts the change                |

**WebSocket event types the server sends:**

| Type        | What it does                                              |
|-------------|-----------------------------------------------------------|
| `welcome`   | Sends the socket ID back to the client on connect         |
| `joined`    | Confirms room entry, sends current user list              |
| `message`   | Delivers a chat message to everyone in the room           |
| `system`    | Broadcasts join/leave/rename notifications                |
| `user_list` | Sends updated list of online users after any change       |
| `typing`    | Forwards typing status to other users in the room         |
| `nick_ok`   | Confirms a successful rename to the requesting client     |
| `error`     | Sends validation or rate-limit errors back to the client  |

**Sanitization:**

- Usernames: letters, numbers, `_`, `-`, `.` only — max 20 characters
- Room names: lowercased, spaces converted to hyphens — max 50 characters
- Messages: trimmed, max 500 characters — HTML escaping is the client's responsibility

**Rate limiting:** 10 messages per 5-second window per connection. Exceeding this sends an error back to that client only.

---

## Tech Stack

| Layer     | Technology                        |
|-----------|-----------------------------------|
| Frontend  | HTML, CSS, Vanilla JavaScript     |
| Backend   | Node.js, ws (WebSocket library)   |
| Hosting   | Firebase Hosting (frontend)       |
| Server    | Render (backend WebSocket server) |

---

## License

MIT — free to use, modify, and distribute.
