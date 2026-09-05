import { UserRole } from "../types";

export const getHierarchicalRoles = (role: UserRole): UserRole[] => {
  const hierarchy = [
    UserRole.RO,
    UserRole.RM,
    UserRole.ASM,
    UserRole.BDM,
    UserRole.BUSINESS_EXECUTIVE,
    UserRole.BUSINESS_HEAD,
    UserRole.ADMIN,
  ];
  
  const roleIndex = hierarchy.indexOf(role);
  if (roleIndex === -1) return [];
  
  // A role can see everyone below it
  return hierarchy.slice(0, roleIndex + 1);
};

export const canManageUsers = (role: UserRole) => role === UserRole.ADMIN;
export const canUploadLeads = (role: UserRole) => role === UserRole.ADMIN;
export const canViewTeamProgress = (role: UserRole) => role !== UserRole.RO;
