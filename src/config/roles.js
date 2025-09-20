const allRoles = {
  user: ['sendMessage', 'getMessages', 'manageChats'],
  admin: ['sendMessage', 'getMessages', 'manageChats', 'getUsers', 'manageUsers'],
};

const roles = Object.keys(allRoles);
const roleRights = new Map(Object.entries(allRoles));

module.exports = {
  roles,
  roleRights,
};
