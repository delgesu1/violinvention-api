// Legacy authentication services removed - using Supabase authentication
// module.exports.authService = require('./auth.service');
// module.exports.userService = require('./user.service');
// module.exports.tokenService = require('./token.service');

// Active services
module.exports.messageService = require('./message.service');
module.exports.chatService = require('./chat.service');
module.exports.vectorStoreService = require('./vectorStore.service');
