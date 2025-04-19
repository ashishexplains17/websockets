const http = require("http")
const { Server } = require("socket.io")
const jwt = require("jsonwebtoken")
const fetch = require("node-fetch")

// Create HTTP server
const server = http.createServer()

// Initialize Socket.IO with CORS settings
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
})

// Store active users and their connections
const activeUsers = new Map()
const userSockets = new Map()
const communityMembers = new Map()
const channelMembers = new Map()
const typingUsers = new Map()

// Verify JWT token from client
const verifyToken = async (token) => {
  try {
    // Verify with your NextAuth secret
    const decoded = jwt.verify(token, process.env.NEXTAUTH_SECRET)
    return {
      id: decoded.id || decoded.sub,
      name: decoded.name,
      email: decoded.email,
      image: decoded.picture || decoded.image,
    }
  } catch (error) {
    console.error("Token verification failed:", error)
    return null
  }
}

// Authentication middleware
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token

    if (!token) {
      return next(new Error("Authentication token required"))
    }

    const user = await verifyToken(token)

    if (!user) {
      return next(new Error("Invalid authentication token"))
    }

    // Store user data in socket
    socket.data.user = user
    next()
  } catch (error) {
    console.error("Socket authentication error:", error)
    next(new Error("Authentication failed"))
  }
})

// Handle connections
io.on("connection", (socket) => {
  const userId = socket.data.user.id
  const username = socket.data.user.name
  const userImage = socket.data.user.image

  console.log(`User connected: ${username} (${userId})`)

  // Add user to active users
  activeUsers.set(userId, {
    id: userId,
    name: username,
    image: userImage,
    status: "online",
    lastActive: new Date(),
    socketId: socket.id,
  })

  // Store socket by user ID for direct messaging
  if (!userSockets.has(userId)) {
    userSockets.set(userId, new Set())
  }
  userSockets.get(userId).add(socket.id)

  // Join user's personal room
  socket.join(`user:${userId}`)

  // Broadcast user online status
  io.emit("user:status", {
    userId,
    status: "online",
    lastActive: new Date(),
  })

  // Handle joining a community
  socket.on("joinCommunity", (communityId) => {
    console.log(`User ${username} joined community ${communityId}`)

    // Join community room
    socket.join(`community:${communityId}`)

    // Add user to community members
    if (!communityMembers.has(communityId)) {
      communityMembers.set(communityId, new Map())
    }
    communityMembers.get(communityId).set(userId, {
      id: userId,
      name: username,
      image: userImage,
      status: "online",
      lastActive: new Date(),
    })

    // Notify community members
    socket.to(`community:${communityId}`).emit("community:member:joined", {
      communityId,
      user: {
        id: userId,
        name: username,
        image: userImage,
        status: "online",
      },
    })

    // Send current online members to the user
    const onlineMembers = Array.from(communityMembers.get(communityId).values())
    socket.emit("community:members", {
      communityId,
      members: onlineMembers,
    })
  })

  // Handle new posts
  socket.on("newPost", async (post) => {
    // Broadcast to all connected clients
    io.emit("newPost", post)

    // You could also call your API to store the post
    try {
      await fetch(`${process.env.API_URL}/api/posts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${socket.handshake.auth.token}`,
        },
        body: JSON.stringify(post),
      })
    } catch (error) {
      console.error("Error saving post via API:", error)
    }
  })

  // Handle direct messages
  socket.on("direct:message", async (data) => {
    const { recipientId, message } = data

    // Store message in database (via API call)
    try {
      const response = await fetch(`${process.env.API_URL}/api/chat/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${socket.handshake.auth.token}`,
        },
        body: JSON.stringify({
          chatId: message.chatId,
          content: message.content,
          mediaUrl: message.mediaUrl,
          mediaType: message.mediaType,
        }),
      })

      if (!response.ok) {
        throw new Error("Failed to save message")
      }

      const savedMessage = await response.json()

      // Send message to recipient if online
      if (userSockets.has(recipientId)) {
        userSockets.get(recipientId).forEach((socketId) => {
          io.to(socketId).emit("direct:message:new", savedMessage.message)
        })
      }

      // Send confirmation to sender
      socket.emit("direct:message:sent", savedMessage.message)
    } catch (error) {
      console.error("Error saving direct message:", error)
      socket.emit("error", {
        message: "Failed to send message",
      })
    }
  })

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${username} (${userId})`)

    // Remove socket from user's sockets
    if (userSockets.has(userId)) {
      userSockets.get(userId).delete(socket.id)

      // If user has no more sockets, they're offline
      if (userSockets.get(userId).size === 0) {
        // Update user status
        if (activeUsers.has(userId)) {
          const userData = activeUsers.get(userId)
          userData.status = "offline"
          userData.lastActive = new Date()
          activeUsers.set(userId, userData)
        }

        // Broadcast user offline status
        io.emit("user:status", {
          userId,
          status: "offline",
          lastActive: new Date(),
        })

        // Remove user from all communities
        for (const [communityId, members] of communityMembers.entries()) {
          if (members.has(userId)) {
            members.delete(userId)

            // Notify community members
            io.to(`community:${communityId}`).emit("community:member:left", {
              communityId,
              userId,
            })
          }
        }

        // Remove user from all channels
        for (const [channelId, members] of channelMembers.entries()) {
          if (members.has(userId)) {
            members.delete(userId)

            // Notify channel members
            io.to(`channel:${channelId}`).emit("channel:member:left", {
              channelId,
              userId,
            })
          }
        }

        // Remove user from typing indicators
        for (const [channelId, typingMap] of typingUsers.entries()) {
          if (typingMap.has(userId)) {
            typingMap.delete(userId)

            // Broadcast updated typing users
            io.to(`channel:${channelId}`).emit(`channel:${channelId}:typing`, {
              channelId,
              userId,
              isTyping: false,
            })
          }
        }
      }
    }
  })
})

// Start the server
const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`)
})
