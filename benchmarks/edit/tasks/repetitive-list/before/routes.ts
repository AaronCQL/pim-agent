type Route = {
  id: string;
  method: string;
  path: string;
  auth: boolean;
  rateLimit: number;
};

export const routes: Route[] = [
  {
    id: "r-001",
    method: "GET",
    path: "/items",
    auth: false,
    rateLimit: 100,
  },
  {
    id: "r-002",
    method: "POST",
    path: "/items",
    auth: true,
    rateLimit: 100,
  },
  {
    id: "r-003",
    method: "GET",
    path: "/orders",
    auth: false,
    rateLimit: 100,
  },
  {
    id: "r-004",
    method: "POST",
    path: "/orders",
    auth: true,
    rateLimit: 100,
  },
  {
    id: "r-005",
    method: "GET",
    path: "/items",
    auth: false,
    rateLimit: 100,
  },
  {
    id: "r-006",
    method: "POST",
    path: "/orders",
    auth: true,
    rateLimit: 100,
  },
  {
    id: "r-007",
    method: "GET",
    path: "/items",
    auth: false,
    rateLimit: 100,
  },
  {
    id: "r-008",
    method: "POST",
    path: "/orders",
    auth: true,
    rateLimit: 100,
  },
];
