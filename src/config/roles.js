const allRoles = {
  user: [
    'sendMessage',
    'getMessages',
    'manageChats',
    'uploadLesson',
    'deleteLesson',
    'searchVectorStore',
  ],
  admin: [
    'sendMessage',
    'getMessages',
    'manageChats',
    'uploadLesson',
    'deleteLesson',
    'searchVectorStore',
    'getUsers',
    'manageUsers',
  ],
};

const roles = Object.keys(allRoles);
const roleRights = new Map(Object.entries(allRoles));

module.exports = {
  roles,
  roleRights,
};
