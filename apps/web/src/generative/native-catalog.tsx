import {
  createComponentImplementation,
  type ReactA2uiComponentProps,
  type ReactComponentImplementation,
} from '@a2ui/react/v0_9';
import { Catalog } from '@a2ui/web_core/v0_9';
import {
  ButtonApi,
  CardApi,
  CheckBoxApi,
  ColumnApi,
  ListApi,
  RowApi,
  TextApi,
  TextFieldApi,
} from '@a2ui/web_core/v0_9/basic_catalog';
import { GENERATIVE_UI_NATIVE_CATALOG_ID } from '@openkit/app-api-schemas';
import type { FC, ReactNode } from 'react';
import { Button, Card, Switch, TextField } from '../primitives';

type BoundChild =
  | string
  | {
      id: string;
      basePath?: string;
    };

interface NativeViewProps {
  props: Record<string, unknown>;
  buildChild: (id: string, basePath?: string) => ReactNode;
}

/**
 * Builds one native catalog component from the upstream v0.9 API and a React Aria view.
 *
 * @param api Upstream component API.
 * @param view Host render function.
 * @returns Official React component implementation.
 */
function implement(
  api: { name: string; schema: unknown },
  view: FC<NativeViewProps>
): ReactComponentImplementation {
  return createComponentImplementation(api as never, view as FC<ReactA2uiComponentProps<never>>);
}

function renderChildren(
  childList: unknown,
  buildChild: (id: string, basePath?: string) => ReactNode
): ReactNode {
  if (typeof childList === 'string') {
    return buildChild(childList);
  }
  if (!Array.isArray(childList)) {
    return null;
  }
  return childList.map((child: BoundChild) => {
    if (typeof child === 'string') {
      return <div key={child}>{buildChild(child)}</div>;
    }
    return (
      <div key={`${child.id}:${child.basePath ?? ''}`}>{buildChild(child.id, child.basePath)}</div>
    );
  });
}

const text = implement(TextApi, ({ props }) => (
  <p className="text-sm text-fg">{String(props.text ?? '')}</p>
));

const row = implement(RowApi, ({ props, buildChild }) => (
  <div className="flex flex-row flex-wrap items-center gap-2">
    {renderChildren(props.children, buildChild)}
  </div>
));

const column = implement(ColumnApi, ({ props, buildChild }) => (
  <div className="flex flex-col gap-2">{renderChildren(props.children, buildChild)}</div>
));

const list = implement(ListApi, ({ props, buildChild }) => (
  <ul className="flex flex-col gap-2">{renderChildren(props.children, buildChild)}</ul>
));

const card = implement(CardApi, ({ props, buildChild }) => (
  <Card className="p-3">{renderChildren(props.child ?? props.children, buildChild)}</Card>
));

const button = implement(ButtonApi, ({ props, buildChild }) => (
  <Button
    size="sm"
    onPress={() => {
      const action = props.action;
      if (typeof action === 'function') {
        action();
      }
    }}
    isDisabled={props.isValid === false}
  >
    {typeof props.child === 'string' ? buildChild(props.child) : 'Submit'}
  </Button>
));

const textField = implement(TextFieldApi, ({ props }) => (
  <TextField
    label={String(props.label ?? 'Field')}
    value={String(props.value ?? '')}
    onChange={(next) => {
      const setValue = props.setValue;
      if (typeof setValue === 'function') {
        setValue(next);
      }
    }}
  />
));

const checkBox = implement(CheckBoxApi, ({ props }) => (
  <Switch
    isSelected={Boolean(props.value)}
    onChange={(next) => {
      const setValue = props.setValue;
      if (typeof setValue === 'function') {
        setValue(next);
      }
    }}
  >
    {String(props.label ?? 'Toggle')}
  </Switch>
));

/** Official A2UI v0.9 catalog with React Aria renderers for the eight native types. */
export const nativeGenerativeCatalog = new Catalog<ReactComponentImplementation>(
  GENERATIVE_UI_NATIVE_CATALOG_ID,
  [text, row, column, list, card, button, textField, checkBox]
);
