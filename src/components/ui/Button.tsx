import type { ButtonHTMLAttributes } from 'react';
import { classNames } from '../../lib/utils';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({ className, ...props }: ButtonProps) {
  return <button className={classNames('text-button', className)} {...props} />;
}
