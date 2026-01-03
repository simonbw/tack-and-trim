import Body from "./Body";
import DynamicBody from "./DynamicBody";
import KinematicBody from "./KinematicBody";
import StaticBody from "./StaticBody";

export const isDynamicBody = (body: Body): body is DynamicBody =>
  body instanceof DynamicBody;

export const isKinematicBody = (body: Body): body is KinematicBody =>
  body instanceof KinematicBody;

export const isStaticBody = (body: Body): body is StaticBody =>
  body instanceof StaticBody;
