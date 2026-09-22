/** Stateless secret-shape pattern shared by authored and resolved build-argument checks. */
export const SECRET_SHAPED_BUILD_ARGUMENT_PATTERN =
  /(api.?key|authorization|client.?secret|credential|password|secret|token)/i;
